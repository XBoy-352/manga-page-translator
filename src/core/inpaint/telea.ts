// Faithful TypeScript port of OpenCV's INPAINT_TELEA (Telea 2004), from
// opencv/modules/photo/src/inpaint.cpp (icvInpaint / icvCalcFMM /
// icvTeleaInpaintFMM), per docs/SPEC.md §7.7.
//
// Structure mirrors the C++ exactly:
//   - a 1 px expanded grid (h+2)×(w+2) carrying KNOWN/BAND/INSIDE flags,
//   - the narrow band = the ring of known pixels 4-adjacent to the hole,
//   - a fast-marching prepass over the outer region (Chebyshev radius r around
//     the hole) producing negative distance values outside the hole,
//   - the main FMM marching into the hole, filling each pixel from known/band
//     neighbours within Euclidean radius r using Telea's weighted sum
//     (geometry weight |r|^-3 · level-set weight · direction weight) plus the
//     image-gradient term.
// Unmasked pixels are never written, so they stay bit-identical to the input.
// Unlike OpenCV (3-channel BGR) the weighted fill runs over all 4 RGBA
// channels; the gradient of T is channel-independent, so it is computed once
// per filled pixel exactly as OpenCV's per-channel loop would.

const KNOWN = 0; // known outside narrow band
const BAND = 1; // narrow band (known)
const INSIDE = 2; // unknown
const CHANGE = 3; // service flag used by the negated FMM prepass

const INF_T = 1.0e6; // OpenCV seeds t with 1e6 outside the band

// assumption taken -- OpenCV rounds with saturate_cast<uchar>(sat + 0.5) where
// cvRound is round-half-to-even; JS Math.round is half-up, which would bias
// uniform fills by +1, so the half-even rule is reproduced explicitly.
// assumption taken -- weights accumulate in f64 (JS number) where OpenCV uses
// f32; masked-pixel values can differ from cv2.inpaint in the last ulp. The
// §7.7 invariants (unmasked bit-identical, no NaN, plausible diffusion) do not
// require OpenCV bit-equality.
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function clampU8(v: number): number {
  const r = roundHalfEven(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// Fast-marching eikonal solver (OpenCV FastMarching_solve).
function solve(
  i1: number, j1: number, i2: number, j2: number,
  f: Uint8Array, t: Float32Array, ecols: number,
): number {
  const a11 = t[i1 * ecols + j1];
  const a22 = t[i2 * ecols + j2];
  const m12 = Math.min(a11, a22);
  if (f[i1 * ecols + j1] !== INSIDE) {
    if (f[i2 * ecols + j2] !== INSIDE) {
      if (Math.abs(a11 - a22) >= 1.0) return 1 + m12;
      return (a11 + a22 + Math.sqrt(2 - (a11 - a22) * (a11 - a22))) * 0.5;
    }
    return 1 + a11;
  } else if (f[i2 * ecols + j2] !== INSIDE) {
    return 1 + a22;
  }
  return 1 + m12;
}

// Min-heap on (T, insertion order) — mirrors CvPriorityQueueFloat, whose
// CvHeapElem::operator> breaks T ties by insertion order. Parallel typed
// arrays instead of per-element objects (the main fill pushes every hole
// pixel; object churn dominates otherwise).
class FmmHeap {
  private tA = new Float64Array(1024);
  private iA = new Int32Array(1024);
  private jA = new Int32Array(1024);
  private oA = new Int32Array(1024);
  private n = 0;
  private nextOrder = 0;
  topI = 0;
  topJ = 0;

  push(i: number, j: number, t: number): void {
    if (this.n === this.tA.length) this.grow();
    let c = this.n++;
    this.tA[c] = t; this.iA[c] = i; this.jA[c] = j; this.oA[c] = this.nextOrder++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.less(c, p)) { this.swap(c, p); c = p; } else break;
    }
  }

  // Pops the minimum into topI/topJ; returns false when empty.
  pop(): boolean {
    if (this.n === 0) return false;
    this.topI = this.iA[0];
    this.topJ = this.jA[0];
    this.n--;
    if (this.n > 0) {
      this.move(this.n, 0);
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === p) break;
        this.swap(p, m);
        p = m;
      }
    }
    return true;
  }

  private grow(): void {
    const cap = this.tA.length * 2;
    const tA = new Float64Array(cap); tA.set(this.tA);
    const iA = new Int32Array(cap); iA.set(this.iA);
    const jA = new Int32Array(cap); jA.set(this.jA);
    const oA = new Int32Array(cap); oA.set(this.oA);
    this.tA = tA; this.iA = iA; this.jA = jA; this.oA = oA;
  }

  private move(from: number, to: number): void {
    this.tA[to] = this.tA[from]; this.iA[to] = this.iA[from];
    this.jA[to] = this.jA[from]; this.oA[to] = this.oA[from];
  }

  private swap(a: number, b: number): void {
    const t = this.tA[a]; this.tA[a] = this.tA[b]; this.tA[b] = t;
    const i = this.iA[a]; this.iA[a] = this.iA[b]; this.iA[b] = i;
    const j = this.jA[a]; this.jA[a] = this.jA[b]; this.jA[b] = j;
    const o = this.oA[a]; this.oA[a] = this.oA[b]; this.oA[b] = o;
  }

  private less(a: number, b: number): boolean {
    if (this.tA[a] !== this.tA[b]) return this.tA[a] < this.tA[b];
    return this.oA[a] < this.oA[b];
  }
}

// Reusable per-pixel accumulators (avoids allocating four arrays per filled
// pixel; reset before each fill). Values are identical to fresh arrays.
const ACCUM = {
  i: [0, 0, 0, 0],
  x: [0, 0, 0, 0],
  y: [0, 0, 0, 0],
  s: [1.0e-20, 1.0e-20, 1.0e-20, 1.0e-20],
};

// OpenCV icvCalcFMM with negate=true: march outward over the `outer` flag map
// (INSIDE-valued there) from the band, accumulating positive distances, then
// flip signs so the outside of the hole carries negative T values.
function calcFmm(outer: Uint8Array, t: Float32Array, heap: FmmHeap, erows: number, ecols: number): void {
  const changed: number[] = []; // every popped pixel is flagged CHANGE exactly once
  for (;;) {
    if (!heap.pop()) break;
    const ii = heap.topI, jj = heap.topJ;
    const idx = ii * ecols + jj;
    outer[idx] = CHANGE;
    changed.push(idx);
    for (let q = 0; q < 4; q++) {
      const i = q === 0 ? ii - 1 : q === 1 ? ii : q === 2 ? ii + 1 : ii;
      const j = q === 0 || q === 2 ? jj : q === 1 ? jj - 1 : jj + 1;
      if (i <= 0 || j <= 0 || i >= erows || j >= ecols) continue;
      if (outer[i * ecols + j] === INSIDE) {
        const dist = Math.min(
          solve(i - 1, j, i, j - 1, outer, t, ecols),
          solve(i + 1, j, i, j - 1, outer, t, ecols),
          solve(i - 1, j, i, j + 1, outer, t, ecols),
          solve(i + 1, j, i, j + 1, outer, t, ecols),
        );
        t[i * ecols + j] = dist;
        outer[i * ecols + j] = BAND;
        heap.push(i, j, dist);
      }
    }
  }
  // negate pass (OpenCV: CHANGE -> KNOWN, t -> -t), over the reached pixels
  for (const idx of changed) t[idx] = -t[idx];
}

// OpenCV icvTeleaInpaintFMM: march inward over the hole, filling each pixel.
// `out` is the flat RGBA buffer (already a copy of the input); only hole
// pixels are written.
//
// The (2r+1)² source window is precomputed once into per-offset tables
// (flags/T offsets, r components, distance weights, and — for the strict-
// interior fast path — relative RGBA read offsets). Iterating the tables
// reproduces OpenCV's row-major k,l accumulation order exactly; the fast
// path additionally eliminates the per-source bounds checks and border
// fudges, which cannot trigger when the whole window lies inside the image
// interior. Targets near the image border take the generic path below,
// which carries the checks and fudges verbatim.
function teleaInpaintFmm(
  f: Uint8Array, t: Float32Array, out: Uint8ClampedArray,
  range: number, heap: FmmHeap, erows: number, ecols: number, w: number,
): void {
  const offs: number[] = [];
  for (let dk = -range; dk <= range; dk++) {
    for (let dl = -range; dl <= range; dl++) {
      if (dk * dk + dl * dl > range * range) continue;
      offs.push(dk, dl);
    }
  }
  const nOff = offs.length / 2;
  const fOff = new Int32Array(nOff); // offset into the expanded f/t grids
  const rxA = new Float64Array(nOff); // r.x = j - l = -dl
  const ryA = new Float64Array(nOff); // r.y = i - k = -dk
  const dstA = new Float64Array(nOff); // 1/(|r|²·|r|)
  // Relative RGBA-component read offsets from the target image pixel (valid
  // only on the strict-interior fast path, where no border fudge applies):
  // value read at (si, sj); gradI.x neighbours at (si, sj ± 1); gradI.y
  // neighbours at (si ± 1, sj), with (si, sj) = target image pixel + (dk, dl).
  const valOff = new Int32Array(nOff);
  const gxP = new Int32Array(nOff);
  const gxM = new Int32Array(nOff);
  const gyP = new Int32Array(nOff);
  const gyM = new Int32Array(nOff);
  for (let oi = 0; oi < nOff; oi++) {
    const dk = offs[2 * oi], dl = offs[2 * oi + 1];
    fOff[oi] = dk * ecols + dl;
    rxA[oi] = -dl;
    ryA[oi] = -dk;
    const len2 = dk * dk + dl * dl;
    dstA[oi] = len2 === 0 ? 0 : 1 / (len2 * Math.sqrt(len2)); // (0,0) is the target itself, always INSIDE-skipped
    const px = dk * w + dl;
    valOff[oi] = px * 4;
    gxP[oi] = (px + 1) * 4;
    gxM[oi] = (px - 1) * 4;
    gyP[oi] = (px + w) * 4;
    gyM[oi] = (px - w) * 4;
  }

  for (;;) {
    if (!heap.pop()) break;
    const ii = heap.topI, jj = heap.topJ;
    f[ii * ecols + jj] = KNOWN;
    for (let q = 0; q < 4; q++) {
      const i = q === 0 ? ii - 1 : q === 1 ? ii : q === 2 ? ii + 1 : ii;
      const j = q === 0 || q === 2 ? jj : q === 1 ? jj - 1 : jj + 1;
      if (i <= 0 || j <= 0 || i > erows - 1 || j > ecols - 1) continue;
      if (f[i * ecols + j] !== INSIDE) continue;

      const dist = Math.min(
        solve(i - 1, j, i, j - 1, f, t, ecols),
        solve(i + 1, j, i, j - 1, f, t, ecols),
        solve(i - 1, j, i, j + 1, f, t, ecols),
        solve(i + 1, j, i, j + 1, f, t, ecols),
      );
      t[i * ecols + j] = dist;

      // Gradient of T at (i,j) (OpenCV computes this identically per channel).
      let gradTx: number;
      if (f[i * ecols + j + 1] !== INSIDE) {
        gradTx = f[i * ecols + j - 1] !== INSIDE
          ? (t[i * ecols + j + 1] - t[i * ecols + j - 1]) * 0.5
          : t[i * ecols + j + 1] - t[i * ecols + j];
      } else {
        gradTx = f[i * ecols + j - 1] !== INSIDE ? t[i * ecols + j] - t[i * ecols + j - 1] : 0;
      }
      let gradTy: number;
      if (f[(i + 1) * ecols + j] !== INSIDE) {
        gradTy = f[(i - 1) * ecols + j] !== INSIDE
          ? (t[(i + 1) * ecols + j] - t[(i - 1) * ecols + j]) * 0.5
          : t[(i + 1) * ecols + j] - t[i * ecols + j];
      } else {
        gradTy = f[(i - 1) * ecols + j] !== INSIDE ? t[i * ecols + j] - t[(i - 1) * ecols + j] : 0;
      }

      // Strict interior: the whole window avoids the expanded border AND the
      // rows/cols (1 and erows-2 / ecols-2) where OpenCV's gradient index
      // fudges activate, so all reads are pure relative offsets.
      const fast = i - range >= 2 && i + range <= erows - 3 && j - range >= 2 && j + range <= ecols - 3;
      const tIdx = i * ecols + j;

      if (fast) {
        const b = ((i - 1) * w + (j - 1)) * 4;
        let ia0 = 0, ia1 = 0, ia2 = 0, ia3 = 0;
        let jx0 = 0, jx1 = 0, jx2 = 0, jx3 = 0;
        let jy0 = 0, jy1 = 0, jy2 = 0, jy3 = 0;
        let s0 = 1.0e-20, s1 = 1.0e-20, s2 = 1.0e-20, s3 = 1.0e-20;
        for (let oi = 0; oi < nOff; oi++) {
          const fo = tIdx + fOff[oi];
          if (f[fo] === INSIDE) continue;
          const lev = 1 / (1 + Math.abs(t[fo] - dist));
          const rx = rxA[oi], ry = ryA[oi];
          let dir = rx * gradTx + ry * gradTy;
          if (dir <= 0.01 && dir >= -0.01) dir = 0.000001;
          dir = dir < 0 ? -dir : dir;
          const wgt = dstA[oi] * lev * dir;

          const xPlus = f[fo + 1] !== INSIDE;
          const xMinus = f[fo - 1] !== INSIDE;
          const yPlus = f[fo + ecols] !== INSIDE;
          const yMinus = f[fo - ecols] !== INSIDE;
          const vb = b + valOff[oi];
          const gxp = b + gxP[oi], gxm = b + gxM[oi];
          const gyp = b + gyP[oi], gym = b + gyM[oi];

          const v0 = out[vb]; // source pixel value, reused by the one-sided
          // gradient fallbacks and the weighted sum (OpenCV reads it as
          // out(km,lm) / out(kp,lm) / out(k-1,l-1) — the same byte)
          let gA = out[gxp], gB = out[gxm]; // gradI.x operands
          let gradIx = xPlus ? (xMinus ? (gA - gB) * 2 : gA - v0) : (xMinus ? v0 - gB : 0);
          let gC = out[gyp], gD = out[gym]; // gradI.y operands
          let gradIy = yPlus ? (yMinus ? (gC - gD) * 2 : gC - v0) : (yMinus ? v0 - gD : 0);
          ia0 += wgt * v0; jx0 -= wgt * gradIx * rx; jy0 -= wgt * gradIy * ry; s0 += wgt;

          gA = out[gxp + 1]; gB = out[gxm + 1];
          const v1 = out[vb + 1];
          gradIx = xPlus ? (xMinus ? (gA - gB) * 2 : gA - v1) : (xMinus ? v1 - gB : 0);
          gC = out[gyp + 1]; gD = out[gym + 1];
          gradIy = yPlus ? (yMinus ? (gC - gD) * 2 : gC - v1) : (yMinus ? v1 - gD : 0);
          ia1 += wgt * v1; jx1 -= wgt * gradIx * rx; jy1 -= wgt * gradIy * ry; s1 += wgt;

          gA = out[gxp + 2]; gB = out[gxm + 2];
          const v2 = out[vb + 2];
          gradIx = xPlus ? (xMinus ? (gA - gB) * 2 : gA - v2) : (xMinus ? v2 - gB : 0);
          gC = out[gyp + 2]; gD = out[gym + 2];
          gradIy = yPlus ? (yMinus ? (gC - gD) * 2 : gC - v2) : (yMinus ? v2 - gD : 0);
          ia2 += wgt * v2; jx2 -= wgt * gradIx * rx; jy2 -= wgt * gradIy * ry; s2 += wgt;

          gA = out[gxp + 3]; gB = out[gxm + 3];
          const v3 = out[vb + 3];
          gradIx = xPlus ? (xMinus ? (gA - gB) * 2 : gA - v3) : (xMinus ? v3 - gB : 0);
          gC = out[gyp + 3]; gD = out[gym + 3];
          gradIy = yPlus ? (yMinus ? (gC - gD) * 2 : gC - v3) : (yMinus ? v3 - gD : 0);
          ia3 += wgt * v3; jx3 -= wgt * gradIx * rx; jy3 -= wgt * gradIy * ry; s3 += wgt;
        }
        out[b] = clampU8(ia0 / s0 + (jx0 + jy0) / (Math.sqrt(jx0 * jx0 + jy0 * jy0) + 1.0e-20) + 0.5);
        out[b + 1] = clampU8(ia1 / s1 + (jx1 + jy1) / (Math.sqrt(jx1 * jx1 + jy1 * jy1) + 1.0e-20) + 0.5);
        out[b + 2] = clampU8(ia2 / s2 + (jx2 + jy2) / (Math.sqrt(jx2 * jx2 + jy2 * jy2) + 1.0e-20) + 0.5);
        out[b + 3] = clampU8(ia3 / s3 + (jx3 + jy3) / (Math.sqrt(jx3 * jx3 + jy3 * jy3) + 1.0e-20) + 0.5);
      } else {
        // Generic path for targets near the image border: explicit bounds
        // checks and OpenCV's km/kp/lm/lp fudges, exactly as the C++ loop.
        const Ia = ACCUM.i, Jx = ACCUM.x, Jy = ACCUM.y, s = ACCUM.s;
        Ia.fill(0); Jx.fill(0); Jy.fill(0); s.fill(1.0e-20);
        for (let oi = 0; oi < nOff; oi++) {
          const dk = offs[2 * oi], dl = offs[2 * oi + 1];
          const k = i + dk, l = j + dl;
          if (k <= 0 || l <= 0 || k >= erows - 1 || l >= ecols - 1) continue;
          const kx = k * ecols + l;
          if (f[kx] === INSIDE) continue;
          const lev = 1 / (1 + Math.abs(t[kx] - dist));
          const rx = -dl, ry = -dk;
          let dir = rx * gradTx + ry * gradTy;
          if (dir <= 0.01 && dir >= -0.01) dir = 0.000001;
          dir = dir < 0 ? -dir : dir;
          const wgt = dstA[oi] * lev * dir;

          // OpenCV border fudges keeping gradient reads inside the image.
          const km = k - 1 + (k === 1 ? 1 : 0);
          const kp = k - 1 - (k === erows - 2 ? 1 : 0);
          const lm = l - 1 + (l === 1 ? 1 : 0);
          const lp = l - 1 - (l === ecols - 2 ? 1 : 0);
          const xPlus = f[kx + 1] !== INSIDE;
          const xMinus = f[kx - 1] !== INSIDE;
          const yPlus = f[kx + ecols] !== INSIDE;
          const yMinus = f[kx - ecols] !== INSIDE;
          const rowM = km * w, rowP = kp * w, rowMm = (km - 1) * w, rowPp = (kp + 1) * w;
          const colP = lp + 1, colM = lm - 1, colL = lm, colLL = lp;
          const vb = ((k - 1) * w + (l - 1)) * 4;
          for (let c = 0; c < 4; c++) {
            let gradIx: number;
            if (xPlus) {
              gradIx = xMinus
                ? (out[(rowM + colP) * 4 + c] - out[(rowM + colM) * 4 + c]) * 2
                : out[(rowM + colP) * 4 + c] - out[(rowM + colL) * 4 + c];
            } else {
              gradIx = xMinus
                ? out[(rowM + colLL) * 4 + c] - out[(rowM + colM) * 4 + c]
                : 0;
            }
            let gradIy: number;
            if (yPlus) {
              gradIy = yMinus
                ? (out[(rowPp + colL) * 4 + c] - out[(rowMm + colL) * 4 + c]) * 2
                : out[(rowPp + colL) * 4 + c] - out[(rowM + colL) * 4 + c];
            } else {
              gradIy = yMinus
                ? out[(rowP + colL) * 4 + c] - out[(rowMm + colL) * 4 + c]
                : 0;
            }
            const val = out[vb + c];
            Ia[c] += wgt * val;
            Jx[c] -= wgt * (gradIx * rx);
            Jy[c] -= wgt * (gradIy * ry);
            s[c] += wgt;
          }
        }
        const base = ((i - 1) * w + (j - 1)) * 4;
        for (let c = 0; c < 4; c++) {
          const sat = Ia[c] / s[c] + (Jx[c] + Jy[c]) / (Math.sqrt(Jx[c] * Jx[c] + Jy[c] * Jy[c]) + 1.0e-20);
          out[base + c] = clampU8(sat + 0.5);
        }
      }

      f[i * ecols + j] = BAND;
      heap.push(i, j, dist);
    }
  }
}

export function inpaintTelea(rgba: ImageData, mask: Uint8Array, radius?: number): ImageData {
  const w = rgba.width;
  const h = rgba.height;
  const range = Math.max(1, Math.min(Math.round(radius ?? 3), 100)); // OpenCV clamps range to [1, 100]

  const erows = h + 2;
  const ecols = w + 2;
  const f = new Uint8Array(erows * ecols); // flags: KNOWN / BAND / INSIDE
  const t = new Float32Array(erows * ecols).fill(INF_T);
  const out = new Uint8ClampedArray(rgba.data); // copy — unmasked pixels stay bit-identical

  // Expanded mask + hole runs (COPY_MASK_BORDER1_C1; runs drive the
  // run-rectangle construction of the outer prepass region below).
  const holeRuns: number[] = []; // [expandedRow, colStart, colEnd] triples
  for (let i = 0; i < h; i++) {
    const srcRow = i * w;
    const dstRow = (i + 1) * ecols + 1;
    let runStart = -1;
    for (let j = 0; j < w; j++) {
      if (mask[srcRow + j] !== 0) {
        f[dstRow + j] = INSIDE;
        if (runStart < 0) runStart = j;
      } else if (runStart >= 0) {
        holeRuns.push(i + 1, runStart + 1, j);
        runStart = -1;
      }
    }
    if (runStart >= 0) holeRuns.push(i + 1, runStart + 1, w);
  }
  // Border ring stays KNOWN (SET_BORDER1_C1 on the expanded mask).

  // band = dilate(mask, cross3x3) - mask: known pixels 4-adjacent to a hole.
  // Collected from the hole pixels, then sorted ascending — expanded index
  // order IS row-major order, so this reproduces Heap::Add's scan order.
  const cands: number[] = [];
  for (let r = 0; r < holeRuns.length; r += 3) {
    const row = holeRuns[r], a = holeRuns[r + 1], b = holeRuns[r + 2];
    for (let j = a; j <= b; j++) {
      const idx = row * ecols + j;
      if (j >= 2 && f[idx - 1] !== INSIDE) cands.push(idx - 1);
      if (j <= w - 1 && f[idx + 1] !== INSIDE) cands.push(idx + 1);
      if (row >= 2 && f[idx - ecols] !== INSIDE) cands.push(idx - ecols);
      if (row <= h - 1 && f[idx + ecols] !== INSIDE) cands.push(idx + ecols);
    }
  }
  cands.sort((a, b) => a - b);
  const band: number[] = [];
  for (let k = 0; k < cands.length; k++) {
    if (k > 0 && cands[k] === cands[k - 1]) continue;
    band.push(cands[k]);
  }

  const heap = new FmmHeap(); // Heap (main fill)
  for (const idx of band) heap.push(Math.floor(idx / ecols), idx % ecols, 0);
  for (const idx of band) {
    f[idx] = BAND;
    t[idx] = 0;
  }

  // Outer region for the distance prepass: dilate(mask, rect(2r+1)) - mask -
  // band, carried as INSIDE-valued flags (OpenCV dilates the 2-valued mask).
  // The Chebyshev dilation of the hole set is the union of the hole-run
  // rectangles expanded by `range` — built here with row fills; identical set
  // to a full-grid dilate+subtract, without the O(page) passes. Rectangles
  // are clipped to [1..h]×[1..w], which also realizes SET_BORDER1_C1(out, 0)
  // (the prepass never marches on the expanded border).
  const outer = new Uint8Array(erows * ecols);
  for (let r = 0; r < holeRuns.length; r += 3) {
    const row = holeRuns[r];
    const a = Math.max(1, holeRuns[r + 1] - range);
    const b = Math.min(w, holeRuns[r + 2] + range);
    const y0 = Math.max(1, row - range);
    const y1 = Math.min(h, row + range);
    for (let y = y0; y <= y1; y++) {
      outer.fill(INSIDE, y * ecols + a, y * ecols + b + 1);
    }
  }
  for (let r = 0; r < holeRuns.length; r += 3) {
    const row = holeRuns[r], a = holeRuns[r + 1], b = holeRuns[r + 2];
    outer.fill(0, row * ecols + a, row * ecols + b + 1); // subtract the holes
  }
  for (const idx of band) outer[idx] = 0; // subtract the band

  const outHeap = new FmmHeap(); // Out (prepass)
  for (const idx of band) outHeap.push(Math.floor(idx / ecols), idx % ecols, 0);
  calcFmm(outer, t, outHeap, erows, ecols);

  teleaInpaintFmm(f, t, out, range, heap, erows, ecols, w);

  // Node test environment has no ImageData global; return a structurally
  // identical object there. Browsers and workers always take the native path.
  const g = globalThis as unknown as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData };
  if (typeof g.ImageData === 'function') return new g.ImageData(out, w, h);
  return { width: w, height: h, data: out } as unknown as ImageData;
}
