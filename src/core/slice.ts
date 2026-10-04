// SPEC §7.2 — webtoon slicing. Pure module, no DOM.

/**
 * A horizontal sub-image cut from a tall strip.
 *
 * assumption taken -- SPEC §7.2 annotates Slice as "natural-pixel rows" while
 * `planSlices` receives the ÷4-downscaled luma plane, so the downscale factor
 * is fixed at 4 and cut positions are reported in natural pixels, assuming an
 * exact ÷4 downscale (natural height = 4 × h). If the true natural height is
 * not a multiple of 4, the caller clamps the final `y1`.
 */
export interface Slice {
  y0: number;
  y1: number;
}

/** SPEC §7.2: input luma is the luminance plane of a ÷4 downscale. */
const DOWNSCALE = 4;

/** Default cap on one slice's height, in natural pixels (SPEC §7.2). */
const DEFAULT_MAX_SLICE_HEIGHT = 1200;

/** Default minimum run of consecutive empty (downscaled) rows that forms a band. */
const DEFAULT_MIN_BAND = 48;

/** A row is empty when p95(luma_row) − p5(luma_row) < 12 (SPEC §7.2). */
const EMPTY_SPREAD_MAX = 12;

/**
 * Empty-row test from a 256-bin histogram (no sorting): p95 − p5 < 12.
 *
 * assumption taken -- SPEC §7.2 does not fix a percentile convention; p5/p95
 * are the smallest values whose cumulative histogram count reaches 0.05 × w
 * and 0.95 × w respectively.
 */
function rowIsEmpty(hist: Uint32Array, total: number): boolean {
  if (total <= 0) return true;
  const p5Target = 0.05 * total;
  const p95Target = 0.95 * total;
  let cum = 0;
  let p5 = -1;
  for (let v = 0; v < 256; v++) {
    const count = hist[v];
    if (count === 0) continue;
    cum += count;
    if (p5 < 0 && cum >= p5Target) p5 = v;
    if (cum >= p95Target) return v - p5 < EMPTY_SPREAD_MAX;
  }
  return true; // unreachable for total > 0
}

/**
 * Split a tall strip into slices, cutting on empty row bands so no bubble is
 * cut (unless a force-cut at the cap is unavoidable — documented §7.2 risk).
 *
 * `luma` is the row-major luminance plane of a ÷4 downscale, width `w`,
 * height `h` downscaled rows. Returned slices are contiguous and tile
 * [0, 4·h) in natural-pixel rows.
 *
 * - `maxSliceHeight` (default 1200): cap on one slice's height, natural px.
 * - `minBand` (default 48): minimum run of consecutive empty downscaled rows
 *   that forms a band; cuts happen at band centers.
 *
 * assumption taken -- §7.2's "cut at the first band center below
 * y0 + maxSliceHeight" is read as the band center nearest below the cap
 * (largest center in (y0, y0 + maxSliceHeight)): slices are packed up to the
 * cap, which keeps the slice count (and det calls) minimal — the alternative
 * reading (first band after y0) would shard dense pages into many tiny slices
 * and contradict the "maxSliceHeight" name and the AC3 det budget.
 * assumption taken -- when the remaining strip already fits within the cap
 * (y0 + maxSliceHeight ≥ natural end) it is emitted unsplit: cuts exist only
 * to enforce maxSliceHeight, so a strip never taller than the cap yields one
 * slice regardless of bands.
 */
export function planSlices(
  luma: Uint8Array,
  w: number,
  h: number,
  opts?: { maxSliceHeight?: number; minBand?: number },
): Slice[] {
  // assumption taken -- degenerate non-positive opts are clamped to 1 so the
  // greedy walk below always makes progress and terminates.
  const maxSliceHeight = Math.max(1, opts?.maxSliceHeight ?? DEFAULT_MAX_SLICE_HEIGHT);
  const minBand = Math.max(1, opts?.minBand ?? DEFAULT_MIN_BAND);
  const naturalH = h * DOWNSCALE;
  const slices: Slice[] = [];
  if (w <= 0 || h <= 0) return slices;

  // Per-row emptiness via a 256-bin histogram; no sorting (SPEC §7.2).
  const empty = new Uint8Array(h);
  const hist = new Uint32Array(256);
  for (let r = 0; r < h; r++) {
    hist.fill(0);
    const off = r * w;
    for (let x = 0; x < w; x++) hist[luma[off + x]]++;
    empty[r] = rowIsEmpty(hist, w) ? 1 : 0;
  }

  // Bands: maximal runs of ≥ minBand consecutive empty downscaled rows.
  // A band covering downscaled rows [b0, b1) covers natural rows [4·b0, 4·b1);
  // its center in natural pixels is 4·b0 + 2·(b1 − b0) = 2·(b0 + b1).
  const centers: number[] = [];
  for (let r = 0; r < h; ) {
    if (empty[r] === 0) {
      r++;
      continue;
    }
    let end = r;
    while (end < h && empty[end] === 1) end++;
    if (end - r >= minBand) centers.push(2 * (r + end));
    r = end;
  }

  // Greedy top→down walk. `bi` points at the first band not yet consumed;
  // bands with center ≤ y0 can never be cut again (zero-length slice).
  let y0 = 0;
  let bi = 0;
  while (y0 < naturalH) {
    const cap = y0 + maxSliceHeight;
    if (cap >= naturalH) {
      // Remainder fits within the cap → emit it whole, done.
      slices.push({ y0, y1: naturalH });
      break;
    }
    while (bi < centers.length && centers[bi] <= y0) bi++;
    // Nearest band center strictly below the cap, above y0.
    let j = bi;
    while (j < centers.length && centers[j] < cap) j++;
    if (j > bi) {
      const cut = centers[j - 1];
      slices.push({ y0, y1: cut });
      y0 = cut;
      bi = j; // centers[bi..j-1] ≤ cut = y0 → all consumed
    } else {
      // No band before the cap → force-cut at the cap (§7.2 documented risk:
      // a bubble straddling the cap is then possible).
      slices.push({ y0, y1: cap });
      y0 = cap;
    }
  }
  return slices;
}
