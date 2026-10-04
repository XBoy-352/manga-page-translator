// LaMa patch-wise inpainting per docs/SPEC.md §7.7: for each connected
// component of the (dilated) mask, crop bbox + 64 px context, snap the patch
// size up to multiples of 64, run the lama-manga-dynamic ONNX session, and
// composite the output only where mask = 255. Never runs on the full page.
//
// The session runner is injected (the worker wires onnxruntime); this keeps
// the patch math composable and unit-testable without a 206 MB model.

export interface LamaPatchInput {
  image: Float32Array; // RGB, [0,1], layout CHW = [1,3,H,W]
  mask: Float32Array; // [1,1,H,W], 1.0 = hole
  width: number;
  height: number;
}

// Runs one patch through the LaMa session and returns the [1,3,H,W] float32
// output ([0,1] assumed — see docs/ASSUMPTIONS.md).
export type LamaSessionRunner = (patch: LamaPatchInput) => Promise<Float32Array>;

function snapUp64(v: number): number {
  return Math.ceil(v / 64) * 64;
}

// 4-connected component labelling of the mask (0 = background, 1..n).
function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 255 || labels[start] !== 0) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && mask[idx - 1] === 255 && labels[idx - 1] === 0) {
        labels[idx - 1] = count; stack[sp++] = idx - 1;
      }
      if (x < w - 1 && mask[idx + 1] === 255 && labels[idx + 1] === 0) {
        labels[idx + 1] = count; stack[sp++] = idx + 1;
      }
      if (y > 0 && mask[idx - w] === 255 && labels[idx - w] === 0) {
        labels[idx - w] = count; stack[sp++] = idx - w;
      }
      if (y < h - 1 && mask[idx + w] === 255 && labels[idx + w] === 0) {
        labels[idx + w] = count; stack[sp++] = idx + w;
      }
    }
  }
  return { labels, count };
}

function toImageData(w: number, h: number, data: Uint8ClampedArray): ImageData {
  // Node test environment has no ImageData global; return a structurally
  // identical object there. Browsers and workers always take the native path.
  const g = globalThis as unknown as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData };
  if (typeof g.ImageData === 'function') return new g.ImageData(data, w, h);
  return { width: w, height: h, data } as unknown as ImageData;
}

export async function inpaintLama(rgba: ImageData, mask: Uint8Array, runSession?: LamaSessionRunner): Promise<ImageData> {
  if (!runSession) {
    throw new Error('inpaintLama requires a session runner (the lama worker wires onnxruntime)');
  }
  const w = rgba.width;
  const h = rgba.height;
  const out = new Uint8ClampedArray(rgba.data); // unmasked pixels stay bit-identical
  if (w <= 0 || h <= 0 || mask.length !== w * h) return toImageData(w, h, out);

  const { labels, count } = labelComponents(mask, w, h);
  const src = rgba.data;

  // Per-component bboxes (inclusive), one pass.
  const bx0 = new Int32Array(count).fill(w);
  const by0 = new Int32Array(count).fill(h);
  const bx1 = new Int32Array(count).fill(-1);
  const by1 = new Int32Array(count).fill(-1);
  for (let idx = 0; idx < labels.length; idx++) {
    const c = labels[idx];
    if (c === 0) continue;
    const x = idx % w;
    const y = (idx - x) / w;
    const b = c - 1;
    if (x < bx0[b]) bx0[b] = x;
    if (x > bx1[b]) bx1[b] = x;
    if (y < by0[b]) by0[b] = y;
    if (y > by1[b]) by1[b] = y;
  }

  for (let comp = 1; comp <= count; comp++) {
    const b = comp - 1;
    const x0 = bx0[b], y0 = by0[b], x1 = bx1[b], y1 = by1[b];

    // bbox + 64 px context margin, clamped to the image.
    const cx0 = Math.max(0, x0 - 64);
    const cy0 = Math.max(0, y0 - 64);
    const cx1 = Math.min(w - 1, x1 + 64);
    const cy1 = Math.min(h - 1, y1 + 64);
    // Snap width and height UP to multiples of 64; the extra context is kept
    // by shifting the patch origin toward the image origin when the snapped
    // size would overflow the right/bottom edge. Out-of-image tensor cells
    // are edge-replicated via the clamped source maps below.
    const pw = snapUp64(cx1 - cx0 + 1);
    const ph = snapUp64(cy1 - cy0 + 1);
    const px0 = Math.max(0, Math.min(cx0, w - pw));
    const py0 = Math.max(0, Math.min(cy0, h - ph));

    const image = new Float32Array(3 * ph * pw);
    const patchMask = new Float32Array(ph * pw);
    const srcX = new Int32Array(pw);
    const srcY = new Int32Array(ph);
    for (let tx = 0; tx < pw; tx++) srcX[tx] = Math.min(px0 + tx, w - 1);
    for (let ty = 0; ty < ph; ty++) srcY[ty] = Math.min(py0 + ty, h - 1);
    for (let ty = 0; ty < ph; ty++) {
      const srow = srcY[ty] * w;
      for (let tx = 0; tx < pw; tx++) {
        const sidx = srow + srcX[tx];
        const hole = mask[sidx] === 255 ? 1 : 0;
        patchMask[ty * pw + tx] = hole;
        // RGB, /255 → [0,1] (the model graph computes image·(1−mask)).
        image[(0 * ph + ty) * pw + tx] = src[sidx * 4] / 255;
        image[(1 * ph + ty) * pw + tx] = src[sidx * 4 + 1] / 255;
        image[(2 * ph + ty) * pw + tx] = src[sidx * 4 + 2] / 255;
      }
    }

    const result = await runSession({ image, mask: patchMask, width: pw, height: ph });

    // Composite only where mask = 255.
    for (let ty = 0; ty < ph; ty++) {
      const sy = py0 + ty;
      if (sy >= h) break;
      for (let tx = 0; tx < pw; tx++) {
        const sx = px0 + tx;
        if (sx >= w) break;
        const sidx = sy * w + sx;
        if (mask[sidx] !== 255) continue;
        const didx = sidx * 4;
        out[didx] = result[(0 * ph + ty) * pw + tx] * 255;
        out[didx + 1] = result[(1 * ph + ty) * pw + tx] * 255;
        out[didx + 2] = result[(2 * ph + ty) * pw + tx] * 255;
      }
    }
  }

  return toImageData(w, h, out);
}
