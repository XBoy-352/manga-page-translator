// PP-OCR recognizer + CTC decoding (docs/SPEC.md §7.4). Pure functions; the
// model call is injected (OrtRunner from core/det.ts) so batching, tall-crop
// rotation and decoding are testable without onnxruntime.

import {
  firstOutput,
  resizeRgbaBilinear,
  type OrtRunner,
} from './det';

export interface RecResult {
  text: string;
  score: number;
}

// --- §7.4 constants (binding) ---
export const REC_HEIGHT = 48;
export const REC_MIN_WIDTH = 8;
export const REC_MAX_WIDTH = 320;
export const REC_MAX_BATCH = 16;
/** Tall crops (h/w ≥ 1.6) are recognized at 0°, 90° and 270° (§7.4, A1). */
export const TALL_ASPECT = 1.6;

export interface RecPre {
  /** CHW float32 tensor for a [1, 3, 48, w] rec input. */
  x: Float32Array;
  /** Resized crop width (the model's dynamic width dimension). */
  w: number;
}

/**
 * §7.4 preprocess: RGB order, /255, (x − 0.5) / 0.5; resize to height 48 with
 * width round(48 × cw/ch) clamped to [8, 320].
 */
export function preprocessRec(crop: ImageData): RecPre {
  const cw = crop.width;
  const ch = crop.height;
  if (cw <= 0 || ch <= 0) throw new RangeError('preprocessRec: empty crop');
  const w = Math.min(REC_MAX_WIDTH, Math.max(REC_MIN_WIDTH, Math.round((REC_HEIGHT * cw) / ch)));
  const resized = resizeRgbaBilinear(crop, w, REC_HEIGHT);
  const x = new Float32Array(3 * REC_HEIGHT * w);
  const src = resized.data;
  const plane = REC_HEIGHT * w;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    x[i] = (src[p] / 255 - 0.5) / 0.5; // R
    x[plane + i] = (src[p + 1] / 255 - 0.5) / 0.5; // G
    x[2 * plane + i] = (src[p + 2] / 255 - 0.5) / 0.5; // B
  }
  return { x, w };
}

/**
 * Pads a ≤ 16-crop batch to the max width in the batch (§7.4). Padding cells
 * are 0 — i.e. mid-gray after the (x − 0.5)/0.5 normalization, matching
 * PaddleOCR's rec resize_norm_img padding.
 */
export function buildRecBatch(pres: RecPre[]): { x: Float32Array; w: number } {
  if (pres.length === 0) throw new RangeError('buildRecBatch: no crops');
  const w = Math.max(...pres.map((p) => p.w));
  const plane = REC_HEIGHT * w;
  const x = new Float32Array(pres.length * 3 * plane);
  for (let b = 0; b < pres.length; b++) {
    const p = pres[b];
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < REC_HEIGHT; r++) {
        const srcStart = c * REC_HEIGHT * p.w + r * p.w;
        x.set(p.x.subarray(srcStart, srcStart + p.w), b * 3 * plane + c * plane + r * w);
      }
    }
  }
  return { x, w };
}

/**
 * §7.4 decode: greedy argmax per step, collapse repeats, drop blanks
 * (charset[0] = 'blank'); score = mean of chosen probs over the emitted
 * non-blank steps (PaddleOCR CTCLabelDecode convention).
 *
 * assumption taken -- the parameter is named `logits` per §7.4, but the values
 * are treated as per-class probabilities: the PP-OCR rec inference models emit
 * post-softmax CTC output (CTCHead runs softmax in eval mode), and argmax is
 * identical either way. See docs/ASSUMPTIONS.md.
 */
export function decodeCtc(logits: Float32Array, T: number, C: number, charset: string[]): RecResult {
  if (T <= 0 || C <= 0) return { text: '', score: 0 };
  let text = '';
  let sum = 0;
  let count = 0;
  let prev = -1;
  for (let t = 0; t < T; t++) {
    const base = t * C;
    let best = 0;
    let bestP = logits[base];
    for (let c = 1; c < C; c++) {
      const p = logits[base + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== prev && best !== 0) {
      text += charset[best] ?? '';
      sum += bestP;
      count++;
    }
    prev = best;
  }
  return { text, score: count > 0 ? sum / count : 0 };
}

/** §7.4: ["blank", ...dict lines, " "]; blank = index 0, space appended last. */
export function buildCharset(dictTxt: string): string[] {
  const lines = dictTxt
    .replace(/^\uFEFF/, '') // strip a UTF-8 BOM if the dict file carries one
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0);
  return ['blank', ...lines, ' '];
}

/** Rotates a crop by 90° (clockwise) or 270° (= 90° counter-clockwise). */
export function rotateCrop(crop: ImageData, deg: 90 | 270): ImageData {
  const w = crop.width;
  const h = crop.height;
  const src = crop.data;
  const out = new Uint8ClampedArray(w * h * 4);
  // dst is h × w for both rotations.
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const p = (sy * w + sx) * 4;
      // 90° CW: src (sx, sy) → dst (h − 1 − sy, sx). 270° CW: → dst (sy, w − 1 − sx).
      const dx = deg === 90 ? h - 1 - sy : sy;
      const dy = deg === 90 ? sx : w - 1 - sx;
      const q = (dy * h + dx) * 4;
      out[q] = src[p];
      out[q + 1] = src[p + 1];
      out[q + 2] = src[p + 2];
      out[q + 3] = src[p + 3];
    }
  }
  const g = globalThis as unknown as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData };
  if (typeof g.ImageData === 'function') return new g.ImageData(out, h, w);
  return { width: h, height: w, data: out } as unknown as ImageData;
}

/**
 * Splits a rec model output of shape [B, T, C] (also [B, 1, T, C] squeezed or
 * [T, C] for a single crop) into per-crop time/class strides.
 */
function splitBatchOutput(dims: readonly number[], count: number): { T: number; C: number; stride: number } {
  if (dims.length === 3 && (dims[0] === count || count === 1)) {
    return { T: dims[1], C: dims[2], stride: dims[1] * dims[2] };
  }
  if (dims.length === 4 && dims[1] === 1 && (dims[0] === count || count === 1)) {
    return { T: dims[2], C: dims[3], stride: dims[2] * dims[3] };
  }
  if (dims.length === 2 && count === 1) {
    return { T: dims[0], C: dims[1], stride: dims[0] * dims[1] };
  }
  throw new Error(`unexpected recognition output shape [${dims.join(', ')}] for ${count} crops`);
}

/**
 * Full recognition pass with an injected runner: preprocess → ≤ 16-crop
 * zero-padded batches → CTC decode. Tall crops (h/w ≥ 1.6) are recognized at
 * 0°, 90° and 270° and the highest score wins (§7.4, A1); ties keep the
 * un-rotated reading.
 */
export async function recognizeCrops(runner: OrtRunner, crops: ImageData[], charset: string[]): Promise<RecResult[]> {
  const best: RecResult[] = crops.map(() => ({ text: '', score: 0 }));
  if (crops.length === 0) return best;
  const variants: Array<{ crop: number; image: ImageData }> = [];
  crops.forEach((c, i) => {
    variants.push({ crop: i, image: c });
    if (c.height / c.width >= TALL_ASPECT) {
      variants.push({ crop: i, image: rotateCrop(c, 90) });
      variants.push({ crop: i, image: rotateCrop(c, 270) });
    }
  });
  for (let start = 0; start < variants.length; start += REC_MAX_BATCH) {
    const chunk = variants.slice(start, start + REC_MAX_BATCH);
    const pres = chunk.map((v) => preprocessRec(v.image));
    const batch = buildRecBatch(pres);
    const out = firstOutput(
      await runner({ dims: [pres.length, 3, REC_HEIGHT, batch.w], data: batch.x }),
    );
    const { T, C, stride } = splitBatchOutput(out.dims, pres.length);
    for (let b = 0; b < pres.length; b++) {
      const r = decodeCtc(out.data.subarray(b * stride, (b + 1) * stride), T, C, charset);
      if (r.score > best[chunk[b].crop].score) best[chunk[b].crop] = r;
    }
  }
  return best;
}
