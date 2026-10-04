// PP-OCR DB text detector (docs/SPEC.md §7.3). Preprocess and postprocess are
// pure functions; the model call itself is injected as an OrtRunner so the
// geometry is unit-testable without onnxruntime (the worker and the
// integration test inject the real session via lib/ort.ts runSession).

export interface Polygon {
  pts: [number, number][];
  score: number;
}

// --- §7.3 constants (binding) ---
export const DET_LIMIT_SIDE_LEN = 960;
/** ImageNet mean/std applied in BGR channel order (PaddleOCR det preprocessing). */
export const DET_MEAN_BGR: readonly [number, number, number] = [0.485, 0.456, 0.406];
export const DET_STD_BGR: readonly [number, number, number] = [0.229, 0.224, 0.225];
/** DB postprocess constants (PP-OCRv6_small_det.yml values per §7.3). */
export const DB_THRESH = 0.2;
export const DB_BOX_THRESH = 0.45;
export const DB_UNCLIP_RATIO = 1.4;
export const DB_MAX_CANDIDATES = 3000;
/** Component area filter: pixel count at prob-map scale (§7.3 "area ≥ 16"). */
export const DB_MIN_AREA = 16;
/** Min-area-rect short side filter, prob-map px (§7.3 "short side ≥ 3"). */
export const DB_MIN_SHORT_SIDE = 3;
/** §7.3: "Polygons with score < 0.5 are dropped". */
export const DB_MIN_SCORE = 0.5;

// Structural view of an onnxruntime Tensor / session output. det.ts and
// rec.ts never import onnxruntime; lib/ort.ts bridges to the real types.
export interface OrtTensorLike {
  dims: readonly number[];
  data: Float32Array;
}
export type OrtOutput = Record<string, OrtTensorLike>;
/** Runs the model on one input tensor and returns its outputs by name. */
export type OrtRunner = (input: OrtTensorLike) => Promise<OrtOutput>;

/** Single-output models (PP-OCR det/rec): the first output is the result. */
export function firstOutput(out: OrtOutput): OrtTensorLike {
  const key = Object.keys(out)[0];
  if (key === undefined) throw new Error('model returned no outputs');
  return out[key];
}

type Pt = [number, number];

function toImageData(w: number, h: number, data: Uint8ClampedArray): ImageData {
  // Node test environment has no ImageData global; return a structurally
  // identical object there. Browsers and workers always take the native path.
  const g = globalThis as unknown as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData };
  if (typeof g.ImageData === 'function') return new g.ImageData(data, w, h);
  return { width: w, height: h, data } as unknown as ImageData;
}

/** Bilinear resample (cv2.INTER_LINEAR equivalent) with clamped edge sampling. */
export function resizeRgbaBilinear(src: ImageData, dw: number, dh: number): ImageData {
  const sw = src.width;
  const sh = src.height;
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) throw new RangeError('resizeRgbaBilinear: invalid dimensions');
  const out = new Uint8ClampedArray(dw * dh * 4);
  const s = src.data;
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const p00 = (y0 * sw + x0) * 4;
      const p01 = (y0 * sw + x1) * 4;
      const p10 = (y1 * sw + x0) * 4;
      const p11 = (y1 * sw + x1) * 4;
      const d = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = s[p00 + c] + (s[p01 + c] - s[p00 + c]) * fx;
        const bottom = s[p10 + c] + (s[p11 + c] - s[p10 + c]) * fx;
        out[d + c] = top + (bottom - top) * fy;
      }
    }
  }
  return toImageData(dw, dh, out);
}

export interface DetPre {
  /** NCHW float32 tensor for a [1, 3, h, w] det input. */
  x: Float32Array;
  /** Padded tensor width (multiple of 32) — also the prob-map width. */
  w: number;
  /** Padded tensor height (multiple of 32) — also the prob-map height. */
  h: number;
  /** resized / natural scale factor; map prob-map coordinates back by 1/scale. */
  scale: number;
}

/**
 * §7.3 preprocess: BGR order, /255, mean [0.485, 0.456, 0.406], std
 * [0.229, 0.224, 0.225]; longest side resized to ≤ limitSideLen keeping
 * aspect, then H and W padded up to multiples of 32 (bottom/right, raw black,
 * normalized after padding like PaddleOCR's DetResizeForTest).
 */
export function preprocessDet(rgba: ImageData, limitSideLen = DET_LIMIT_SIDE_LEN): DetPre {
  const sw = rgba.width;
  const sh = rgba.height;
  if (sw <= 0 || sh <= 0) throw new RangeError('preprocessDet: empty image');
  const longest = Math.max(sw, sh);
  const scale = longest > limitSideLen ? limitSideLen / longest : 1;
  const rw = Math.max(1, Math.round(sw * scale));
  const rh = Math.max(1, Math.round(sh * scale));
  const w = Math.ceil(rw / 32) * 32;
  const h = Math.ceil(rh / 32) * 32;
  const resized = resizeRgbaBilinear(rgba, rw, rh);
  const x = new Float32Array(3 * w * h);
  const src = resized.data;
  const [meanB, meanG, meanR] = DET_MEAN_BGR;
  const [stdB, stdG, stdR] = DET_STD_BGR;
  const plane = w * h;
  for (let y = 0; y < rh; y++) {
    for (let xi = 0; xi < rw; xi++) {
      const o = y * w + xi;
      const p = (y * rw + xi) * 4;
      // BGR channel order; padded cells stay 0 (raw black before normalization).
      x[o] = (src[p + 2] / 255 - meanB) / stdB;
      x[plane + o] = (src[p + 1] / 255 - meanG) / stdG;
      x[2 * plane + o] = (src[p] / 255 - meanR) / stdR;
    }
  }
  return { x, w, h, scale };
}

interface Rect4 {
  pts: Pt[];
  area: number;
  shortSide: number;
  perimeter: number;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew monotone chain; collinear points dropped, CCW in math orientation. */
function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Min-area enclosing rectangle of a convex hull (rotating calipers over hull
 * edges: for each edge direction, project all hull points onto the edge axis
 * and its normal). Text-blob hulls are small, so the O(hull²) sweep is cheap.
 */
function minAreaRect(hull: Pt[]): Rect4 | null {
  const m = hull.length;
  if (m < 3) return null;
  let best: Rect4 | null = null;
  for (let i = 0; i < m; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % m];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len < 1e-12) continue;
    const dx = ux / len;
    const dy = uy / len;
    const nx = -dy;
    const ny = dx;
    let minU = Infinity;
    let maxU = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const p of hull) {
      const du = p[0] * dx + p[1] * dy;
      const dn = p[0] * nx + p[1] * ny;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dn < minN) minN = dn;
      if (dn > maxN) maxN = dn;
    }
    const wU = maxU - minU;
    const wN = maxN - minN;
    const area = wU * wN;
    if (best && area >= best.area - 1e-12) continue;
    const corner = (cu: number, cn: number): Pt => [cu * dx + cn * nx, cu * dy + cn * ny];
    best = {
      pts: [corner(minU, minN), corner(maxU, minN), corner(maxU, maxN), corner(minU, maxN)],
      area,
      shortSide: Math.min(wU, wN),
      perimeter: 2 * (wU + wN),
    };
  }
  return best;
}

/**
 * Minkowski disk expansion of a convex polygon by radius d: every edge line is
 * offset outward by d, adjacent offset lines intersected. For a convex polygon
 * this is exact (round joins only round the corners, which the following
 * min-area rect ignores), matching PaddleOCR's Clipper JT_ROUND unclip.
 */
function offsetOutward(pts: Pt[], d: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.map((p) => [p[0], p[1]] as Pt);
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  const lines: Array<{ ox: number; oy: number; dx: number; dy: number }> = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const len = Math.hypot(ux, uy);
    if (len < 1e-12) continue;
    let nx = -uy / len;
    let ny = ux / len;
    const mx = (p[0] + q[0]) / 2 - cx;
    const my = (p[1] + q[1]) / 2 - cy;
    if (mx * nx + my * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push({ ox: p[0] + d * nx, oy: p[1] + d * ny, dx: ux / len, dy: uy / len });
  }
  if (lines.length < 3) return pts.map((p) => [p[0], p[1]] as Pt);
  const out: Pt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[(i - 1 + lines.length) % lines.length];
    const b = lines[i];
    const det = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(det) < 1e-9) {
      out.push([b.ox, b.oy]); // parallel fallback (cannot happen for hull edges)
      continue;
    }
    const t = ((b.ox - a.ox) * b.dy - (b.oy - a.oy) * b.dx) / det;
    out.push([a.ox + t * a.dx, a.oy + t * a.dy]);
  }
  return out;
}

/** §7.3 fast score mode: mean prob inside the rect (pixel-center sampling). */
function fastScore(prob: Float32Array, w: number, h: number, quad: Pt[]): number {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  if (minX > maxX || minY > maxY) return 0;
  let area2 = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    area2 += a[0] * b[1] - a[1] * b[0];
  }
  const sign = area2 >= 0 ? 1 : -1;
  let sum = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = true;
      for (let i = 0; i < quad.length && inside; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % quad.length];
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (c * sign < -1e-9) inside = false;
      }
      if (inside) {
        sum += prob[y * w + x];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Extracts the single-channel prob map from a det model output tensor. */
export function detProbMap(out: OrtTensorLike): { prob: Float32Array; w: number; h: number } {
  const dims = out.dims;
  if (dims.length === 4) {
    // [B, C, H, W] — channel 0 is the shrink-map probability.
    const h = dims[2];
    const w = dims[3];
    return { prob: out.data.subarray(0, w * h), w, h };
  }
  if (dims.length === 3) return { prob: out.data, w: dims[2], h: dims[1] }; // [B, H, W]
  if (dims.length === 2) return { prob: out.data, w: dims[1], h: dims[0] }; // [H, W]
  throw new Error(`unexpected det output shape [${dims.join(', ')}]`);
}

/**
 * §7.3 DB postprocess: threshold at 0.2 → 8-connected components (scan order,
 * capped at 3000 candidates) → per component: pixel-count area ≥ 16, min-area
 * rect short side ≥ 3 prob-map px, fast-mode score ≥ 0.45 → unclip by
 * offsetting the min-area rect outward by area × 1.4 / perimeter → map back by
 * 1/scale → min-area rect via rotating calipers. The component score rides on
 * the polygon; polygons with score < 0.5 are dropped (§7.3).
 */
export function postprocessDb(prob: Float32Array, w: number, h: number, scale: number): Polygon[] {
  const size = w * h;
  if (size <= 0 || scale <= 0) return [];
  const bin = new Uint8Array(size);
  for (let i = 0; i < size; i++) bin[i] = prob[i] > DB_THRESH ? 1 : 0;

  // Connected components (8-connected, discovered in row-major scan order).
  const labels = new Int32Array(size);
  const components: number[][] = [];
  const stack = new Int32Array(size);
  for (let start = 0; start < size; start++) {
    if (bin[start] === 0 || labels[start] !== 0) continue;
    const id = components.length + 1;
    labels[start] = id;
    const pixels: number[] = [start];
    let sp = 0;
    stack[sp++] = start;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;
          if (bin[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = id;
            pixels.push(nIdx);
            stack[sp++] = nIdx;
          }
        }
      }
    }
    components.push(pixels);
  }

  const polys: Polygon[] = [];
  const limit = Math.min(components.length, DB_MAX_CANDIDATES);
  for (let ci = 0; ci < limit; ci++) {
    const pixels = components[ci];
    if (pixels.length < DB_MIN_AREA) continue;
    const pts: Pt[] = pixels.map((idx) => {
      const x = idx % w;
      return [x, (idx - x) / w];
    });
    const rect = minAreaRect(convexHull(pts));
    if (!rect || rect.shortSide < DB_MIN_SHORT_SIDE) continue;
    const score = fastScore(prob, w, h, rect.pts as Pt[]);
    if (score < DB_BOX_THRESH) continue;
    // Unclip distance: area × unclip_ratio / perimeter of the min-area rect.
    const d = (rect.area * DB_UNCLIP_RATIO) / rect.perimeter;
    const expanded = offsetOutward(rect.pts as Pt[], d);
    const mapped = expanded.map(([px, py]) => [px / scale, py / scale] as Pt);
    const finalRect = minAreaRect(convexHull(mapped));
    if (!finalRect) continue;
    const maxX = w / scale;
    const maxY = h / scale;
    const clipped = (finalRect.pts as Pt[]).map(([px, py]) => [
      Math.min(Math.max(px, 0), maxX),
      Math.min(Math.max(py, 0), maxY),
    ] as Pt);
    if (score < DB_MIN_SCORE) continue;
    polys.push({ pts: clipped, score });
  }
  return polys;
}

/**
 * Full detection pass with an injected runner: preprocess → model → prob map →
 * DB postprocess. Used by src/worker/ocr.worker.ts and the integration test.
 */
export async function detectWith(runner: OrtRunner, rgba: ImageData, limitSideLen = DET_LIMIT_SIDE_LEN): Promise<Polygon[]> {
  const pre = preprocessDet(rgba, limitSideLen);
  const out = firstOutput(await runner({ dims: [1, 3, pre.h, pre.w], data: pre.x }));
  const { prob, w, h } = detProbMap(out);
  return postprocessDb(prob, w, h, pre.scale);
}
