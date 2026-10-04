import { describe, expect, it } from 'vitest';
import { planSlices, type Slice } from '../src/core/slice';

/**
 * Build a w×h downscaled luma plane. Every row not listed in `emptyRanges`
 * carries text-like contrast (half black / half white → p95 − p5 = 255);
 * listed rows are uniform white (p95 − p5 = 0 → empty).
 * Row indices are downscaled rows; natural height is 4·h.
 */
function makeLuma(w: number, h: number, emptyRanges: Array<[number, number]>): Uint8Array {
  const luma = new Uint8Array(w * h).fill(255);
  const isEmpty = new Uint8Array(h);
  for (const [a, b] of emptyRanges) {
    if (a < 0 || b > h || a >= b) throw new RangeError(`bad empty range [${a}, ${b})`);
    for (let r = a; r < b; r++) isEmpty[r] = 1;
  }
  for (let r = 0; r < h; r++) {
    if (isEmpty[r]) continue;
    for (let x = 0; x < w; x++) luma[r * w + x] = x * 2 < w ? 0 : 255;
  }
  return luma;
}

/** Slices must tile [0, naturalHeight) contiguously with no empty slice. */
function expectTiling(slices: Slice[], naturalHeight: number): void {
  let prev = 0;
  for (const s of slices) {
    expect(s.y0).toBe(prev);
    expect(s.y1).toBeGreaterThan(s.y0);
    prev = s.y1;
  }
  expect(prev).toBe(naturalHeight);
}

describe('planSlices (SPEC §7.2)', () => {
  it('cuts a two-band strip at band centers, force-cutting when no band precedes the cap', () => {
    // Empty downscaled rows [10,20) and [26,34) → bands with natural centers
    // 2·(10+20)=60 and 2·(26+34)=120; natural height 240.
    const luma = makeLuma(8, 60, [[10, 20], [26, 34]]);
    expect(planSlices(luma, 8, 60, { maxSliceHeight: 100, minBand: 8 })).toEqual([
      { y0: 0, y1: 60 }, // band center 60 < cap 100
      { y0: 60, y1: 120 }, // band center 120 < cap 160
      { y0: 120, y1: 220 }, // no band in (120, 220) → force-cut at the cap
      { y0: 220, y1: 240 }, // remainder fits the cap → unsplit
    ]);
    // Every internal cut lands inside an empty band, never on a content row.
    const emptyRows = new Set<number>();
    for (const [a, b] of [[10, 20], [26, 34]] as const) {
      for (let r = a; r < b; r++) emptyRows.add(r);
    }
    for (const cut of [60, 120]) expect(emptyRows.has(cut / 4)).toBe(true);
  });

  it('packs each slice up to the cap: the band center nearest below the cap wins', () => {
    const luma = makeLuma(8, 60, [[10, 20], [26, 34]]);
    // Cap 239: both centers (60, 120) are below it; the nearest one (120) is used.
    expect(planSlices(luma, 8, 60, { maxSliceHeight: 239, minBand: 8 })).toEqual([
      { y0: 0, y1: 120 },
      { y0: 120, y1: 240 },
    ]);
  });

  it('leaves a strip that fits within maxSliceHeight unsplit', () => {
    const luma = makeLuma(8, 60, [[10, 20], [26, 34]]);
    expect(planSlices(luma, 8, 60, { maxSliceHeight: 240, minBand: 8 })).toEqual([
      { y0: 0, y1: 240 },
    ]);
    expect(planSlices(luma, 8, 60, { maxSliceHeight: 1000 })).toEqual([{ y0: 0, y1: 240 }]);
  });

  it('force-cuts exactly at the cap when a strip has no usable band', () => {
    const luma = makeLuma(8, 50, []); // all rows carry content; natural height 200
    expect(planSlices(luma, 8, 50, { maxSliceHeight: 60 })).toEqual([
      { y0: 0, y1: 60 },
      { y0: 60, y1: 120 },
      { y0: 120, y1: 180 },
      { y0: 180, y1: 200 },
    ]);
  });

  it('uses the spec defaults: maxSliceHeight 1200 natural px, minBand 48 downscaled rows', () => {
    // 47 empty rows stay below the default minBand → no band → force-cuts at 1200.
    const shortBand = makeLuma(4, 400, [[10, 57]]);
    expect(planSlices(shortBand, 4, 400)).toEqual([
      { y0: 0, y1: 1200 },
      { y0: 1200, y1: 1600 },
    ]);
    // 48 empty rows form a band (natural center 136); the next cap lands at 136+1200.
    const exactBand = makeLuma(4, 400, [[10, 58]]);
    expect(planSlices(exactBand, 4, 400)).toEqual([
      { y0: 0, y1: 136 },
      { y0: 136, y1: 1336 },
      { y0: 1336, y1: 1600 },
    ]);
  });

  it('treats a band center exactly on the cap as not below it; one row of slack uses the band', () => {
    const luma = makeLuma(8, 50, [[10, 20]]); // band center 60 natural
    // Cap 60: center 60 is not below the cap → force-cut lands on the same row.
    expect(planSlices(luma, 8, 50, { maxSliceHeight: 60, minBand: 10 })).toEqual([
      { y0: 0, y1: 60 },
      { y0: 60, y1: 120 },
      { y0: 120, y1: 180 },
      { y0: 180, y1: 200 },
    ]);
    // Cap 64: center 60 is below the cap → cut at the band center, then exact caps.
    expect(planSlices(luma, 8, 50, { maxSliceHeight: 64, minBand: 10 })).toEqual([
      { y0: 0, y1: 60 },
      { y0: 60, y1: 124 },
      { y0: 124, y1: 188 },
      { y0: 188, y1: 200 },
    ]);
  });

  it('caps the final slice exactly at the natural height', () => {
    const luma = makeLuma(8, 25, []); // natural height 100
    expect(planSlices(luma, 8, 25, { maxSliceHeight: 100 })).toEqual([{ y0: 0, y1: 100 }]);
    expect(planSlices(luma, 8, 25, { maxSliceHeight: 101 })).toEqual([{ y0: 0, y1: 100 }]);
    expect(planSlices(luma, 8, 25, { maxSliceHeight: 99 })).toEqual([
      { y0: 0, y1: 99 },
      { y0: 99, y1: 100 },
    ]);
  });

  it('handles tiny images', () => {
    expect(planSlices(new Uint8Array(0), 8, 0)).toEqual([]);
    // 1×1 downscaled → 4 natural rows, no band (run of 1 < default minBand).
    expect(planSlices(Uint8Array.of(255), 1, 1)).toEqual([{ y0: 0, y1: 4 }]);
    // A 1px-wide plane has no content rows (p5 == p95); with minBand 1 the
    // whole run is one band centered at 2·(0+3)=6.
    expect(
      planSlices(new Uint8Array(3).fill(255), 1, 3, { maxSliceHeight: 8, minBand: 1 }),
    ).toEqual([{ y0: 0, y1: 6 }, { y0: 6, y1: 12 }]);
    // An empty run shorter than minBand is not a band → force-cuts only.
    expect(
      planSlices(makeLuma(4, 6, [[1, 3]]), 4, 6, { maxSliceHeight: 10, minBand: 3 }),
    ).toEqual([{ y0: 0, y1: 10 }, { y0: 10, y1: 20 }, { y0: 20, y1: 24 }]);
  });

  it('always emits contiguous slices covering exactly [0, 4h)', () => {
    const cases: Array<{ luma: Uint8Array; w: number; h: number; opts?: { maxSliceHeight?: number; minBand?: number } }> = [
      { luma: makeLuma(8, 60, [[10, 20], [26, 34]]), w: 8, h: 60, opts: { maxSliceHeight: 100, minBand: 8 } },
      { luma: makeLuma(8, 60, [[10, 20], [26, 34]]), w: 8, h: 60, opts: { maxSliceHeight: 239, minBand: 8 } },
      { luma: makeLuma(8, 50, []), w: 8, h: 50, opts: { maxSliceHeight: 60 } },
      { luma: makeLuma(4, 400, [[10, 58]]), w: 4, h: 400 },
      { luma: makeLuma(4, 6, [[1, 3]]), w: 4, h: 6, opts: { maxSliceHeight: 10, minBand: 3 } },
    ];
    for (const c of cases) {
      expectTiling(planSlices(c.luma, c.w, c.h, c.opts), 4 * c.h);
    }
  });
});
