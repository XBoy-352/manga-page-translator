// Text mask construction per docs/SPEC.md §7.7: rasterize each polygon
// (fill + strokePx stroke), then dilate the binary mask by padPx using a
// separable two-pass max filter. 255 = inpaint.

// assumption taken -- §7.3 defines Polygon in core/det.ts (owned by slice s4);
// it is declared structurally here so s6 does not depend on s4, matching the
// local-declaration pattern slice s5 uses in core/cluster.ts. score is optional
// in the s6 slice contract so bare { pts } lists are accepted too; §7.3
// Polygon (score required) remains assignable.
interface Polygon {
  pts: [number, number][];
  score?: number;
}

// Binaries the polygon fill + stroke into `out` using an OffscreenCanvas —
// the production path named by §7.7. Returns null when OffscreenCanvas or a
// 2D context is unavailable (node test environment), so the caller can fall
// back to the equivalent pure rasterizer below.
function rasterizeCanvas(polys: Polygon[], w: number, h: number, strokePx: number): Uint8Array | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = strokePx;
    // Round joins/caps make the stroke exactly the set of pixels whose center
    // lies within strokePx/2 of the polygon boundary (Minkowski disk band),
    // which is what the pure fallback below reproduces.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const poly of polys) {
      const pts = poly.pts;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      if (pts.length >= 3) ctx.fill();
      if (strokePx > 0) ctx.stroke();
    }
    const px = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] >= 128 ? 255 : 0; // ≥50% coverage
    return out;
  } catch {
    return null;
  }
}

// Pure-TS rasterizer used only where OffscreenCanvas does not exist (node
// tests). Fill = even-odd scanline sampling at pixel centers; stroke = pixel
// center within strokePx/2 of the closed polygon boundary (exact for round
// joins/caps, matching the canvas path above).
function rasterizePure(polys: Polygon[], w: number, h: number, strokePx: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const half = strokePx / 2;
  for (const poly of polys) {
    const pts = poly.pts;
    if (pts.length < 2) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of pts) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const x0 = Math.max(0, Math.floor(minX - half));
    const x1 = Math.min(w - 1, Math.ceil(maxX + half));
    const y0 = Math.max(0, Math.floor(minY - half));
    const y1 = Math.min(h - 1, Math.ceil(maxY + half));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      // Even-odd scanline fill: crossings of the closed polygon with y = cy.
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        // pixel centers cx = x + 0.5 with a <= cx <= b
        const from = Math.max(x0, Math.ceil(xs[s] - 0.5));
        const to = Math.min(x1, Math.floor(xs[s + 1] - 0.5));
        for (let x = from; x <= to; x++) out[y * w + x] = 255;
      }
      if (half > 0) {
        for (let x = x0; x <= x1; x++) {
          const idx = y * w + x;
          if (out[idx] !== 0) continue;
          const cx = x + 0.5;
          let dmin = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const [ax, ay] = pts[i];
            const [bx, by] = pts[(i + 1) % pts.length];
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = cx - (ax + t * dx), ey = cy - (ay + t * dy);
            const d = Math.sqrt(ex * ex + ey * ey);
            if (d < dmin) dmin = d;
          }
          if (dmin <= half) out[idx] = 255;
        }
      }
    }
  }
  return out;
}

// Separable two-pass max filter (horizontal then vertical sliding window of
// radius r) — a square structuring element, per §7.7. O(n) per pass via a
// monotonic deque.
function maxPass1d(src: Uint8Array, dst: Uint8Array, stride: number, r: number, base: number, lo: number, hi: number, dq: Int32Array): void {
  // Sliding max over [lo..hi] only (outside that window the result is 0 and
  // dst is pre-zeroed). head/tail index into dq which stores positions.
  let head = 0, tail = 0;
  for (let x = lo; x <= hi; x++) {
    const v = src[base + x * stride];
    while (tail > head && src[base + dq[tail - 1] * stride] <= v) tail--;
    dq[tail++] = x;
    const c = x - r;
    if (c >= lo) {
      while (dq[head] < c - r) head++;
      dst[base + c * stride] = src[base + dq[head] * stride];
    }
  }
  for (let c = Math.max(lo, hi + 1 - r); c <= hi; c++) {
    while (dq[head] < c - r) head++;
    dst[base + c * stride] = src[base + dq[head] * stride];
  }
}

// For a binary (0/255) line, the sliding-window max equals the union of the
// set runs expanded by r on each side — so each separable pass can be
// evaluated by run detection + row fills instead of an element-wise deque
// sweep. Identical output, far fewer memory passes on strided columns.
function maxPass1dBinary(src: Uint8Array, dst: Uint8Array, stride: number, r: number, base: number, lo: number, hi: number): void {
  let runStart = -1;
  for (let x = lo; x <= hi + 1; x++) {
    const v = x <= hi ? src[base + x * stride] : 0;
    if (v !== 0) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      for (let c = Math.max(lo, runStart - r); c <= Math.min(hi, x - 1 + r); c++) {
        dst[base + c * stride] = src[base + runStart * stride];
      }
      runStart = -1;
    }
  }
}

function dilateMax(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src;
  // The dilated mask is nonzero only within the content bbox expanded by r;
  // both separable passes run restricted to that window (identical output,
  // everything outside stays 0).
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (src[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  if (maxX < 0) return out; // empty mask
  const y0 = Math.max(0, minY - r), y1 = Math.min(h - 1, maxY + r);
  const x0 = Math.max(0, minX - r), x1 = Math.min(w - 1, maxX + r);
  // Binary fast path: buildMask always feeds 0/255, so both separable passes
  // run as run-expansions; anything else falls back to the deque filter.
  let binary = true;
  for (let y = y0; y <= y1 && binary; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const v = src[row + x];
      if (v !== 0 && v !== 255) { binary = false; break; }
    }
  }
  if (binary) {
    for (let y = y0; y <= y1; y++) maxPass1dBinary(src, tmp, 1, r, y * w, x0, x1);
    for (let x = x0; x <= x1; x++) maxPass1dBinary(tmp, out, w, r, x, y0, y1);
    return out;
  }
  const dqRow = new Int32Array(x1 - x0 + 1);
  for (let y = y0; y <= y1; y++) maxPass1d(src, tmp, 1, r, y * w, x0, x1, dqRow);
  const dqCol = new Int32Array(y1 - y0 + 1);
  for (let x = x0; x <= x1; x++) maxPass1d(tmp, out, w, r, x, y0, y1, dqCol);
  return out;
}

export function buildMask(
  polys: Polygon[],
  w: number,
  h: number,
  opts?: { strokePx?: number; padPx?: number },
): Uint8Array {
  const strokePx = opts?.strokePx ?? 4;
  const padPx = opts?.padPx ?? 24;
  if (w <= 0 || h <= 0) return new Uint8Array(Math.max(0, w * h));
  let binary = rasterizeCanvas(polys, w, h, strokePx);
  if (binary === null) binary = rasterizePure(polys, w, h, strokePx);
  return dilateMax(binary, w, h, padPx);
}
