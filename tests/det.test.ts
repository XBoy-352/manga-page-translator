import { describe, expect, it } from 'vitest';
import {
  DB_BOX_THRESH,
  DB_MAX_CANDIDATES,
  DB_MIN_SCORE,
  DB_THRESH,
  DB_UNCLIP_RATIO,
  postprocessDb,
  preprocessDet,
  type Polygon,
} from '../src/core/det';

type Rgba = [number, number, number, number];

function makeImage(w: number, h: number, fill?: (x: number, y: number) => Rgba): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = fill(x, y);
        const o = (y * w + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a;
      }
    }
  }
  return { width: w, height: h, data } as unknown as ImageData;
}

function probMap(
  w: number,
  h: number,
  blocks: Array<{ x0: number; y0: number; x1: number; y1: number; v: number }>,
): Float32Array {
  const p = new Float32Array(w * h);
  for (const b of blocks) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) p[y * w + x] = b.v;
    }
  }
  return p;
}

/** Asserts a polygon is the 4-point rect [minX, minY]–[maxX, maxY]. */
function expectRect(poly: Polygon, minX: number, minY: number, maxX: number, maxY: number): void {
  expect(poly.pts.length).toBe(4);
  const xs = poly.pts.map((p) => p[0]);
  const ys = poly.pts.map((p) => p[1]);
  expect(Math.min(...xs)).toBeCloseTo(minX, 6);
  expect(Math.min(...ys)).toBeCloseTo(minY, 6);
  expect(Math.max(...xs)).toBeCloseTo(maxX, 6);
  expect(Math.max(...ys)).toBeCloseTo(maxY, 6);
}

describe('preprocessDet (SPEC §7.3)', () => {
  it('normalizes in BGR order with /255, ImageNet mean and std', () => {
    const pre = preprocessDet(makeImage(1, 1, () => [255, 128, 0, 255]));
    // 1×1 input pads to 32×32; channel 0 is B, channel 1 G, channel 2 R.
    expect(pre.w).toBe(32);
    expect(pre.h).toBe(32);
    expect(pre.scale).toBe(1);
    expect(pre.x.length).toBe(3 * 32 * 32);
    expect(pre.x[0]).toBeCloseTo((0 / 255 - 0.485) / 0.229, 6); // B (f32 storage)
    expect(pre.x[32 * 32]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 6); // G
    expect(pre.x[2 * 32 * 32]).toBeCloseTo((255 / 255 - 0.406) / 0.225, 6); // R
    // Padded cells stay 0 (raw black before normalization).
    expect(pre.x[1]).toBe(0);
    expect(pre.x[31 * 32 + 31]).toBe(0);
  });

  it('resizes the longest side to ≤ 960 keeping aspect, then pads to 32 multiples', () => {
    // 1920×100 → scale 0.5 → 960×50 → padded to 960×64.
    const wide = preprocessDet(makeImage(1920, 100));
    expect(wide.scale).toBeCloseTo(0.5, 12);
    expect(wide.w).toBe(960);
    expect(wide.h).toBe(64);
    expect(wide.x.length).toBe(3 * 960 * 64);
    // 500×300 fits: no resize (scale 1), only padding 500→512, 300→320.
    const small = preprocessDet(makeImage(500, 300));
    expect(small.scale).toBe(1);
    expect(small.w).toBe(512);
    expect(small.h).toBe(320);
    // 65×33: no resize, padding 65→96, 33→64.
    const tiny = preprocessDet(makeImage(65, 33));
    expect(tiny.scale).toBe(1);
    expect(tiny.w).toBe(96);
    expect(tiny.h).toBe(64);
  });
});

describe('postprocessDb (SPEC §7.3)', () => {
  it('unclips a known 32×32 rectangle by area × ratio / perimeter and maps back by 1/scale', () => {
    // Prob-map block at (16,16)–(47,47). The min-area rect spans pixel centers,
    // so its sides are 31×31 (cv2.findContours + minAreaRect convention).
    // d = 961 × unclip_ratio / 124 = 10.85 → expanded (5.15,5.15)–(57.85,57.85).
    const d = (31 * 31 * DB_UNCLIP_RATIO) / (2 * (31 + 31));
    const polys = postprocessDb(probMap(64, 64, [{ x0: 16, y0: 16, x1: 47, y1: 47, v: 1 }]), 64, 64, 1);
    expect(polys.length).toBe(1);
    expectRect(polys[0], 16 - d, 16 - d, 47 + d, 47 + d);
    expect(polys[0].score).toBeCloseTo(1, 6);
    expect(16 - d).toBeCloseTo(5.15, 9); // sanity: d = 10.85 for ratio 1.4
  });

  it('unclips a non-square rectangle', () => {
    // Block (10,20)–(29,29): 20×10 px → center-span rect 19×9, area 171,
    // perimeter 56, d = 171 × 1.4 / 56 = 4.275.
    const d = (19 * 9 * DB_UNCLIP_RATIO) / (2 * (19 + 9));
    const polys = postprocessDb(probMap(64, 64, [{ x0: 10, y0: 20, x1: 29, y1: 29, v: 1 }]), 64, 64, 1);
    expect(polys.length).toBe(1);
    expectRect(polys[0], 10 - d, 20 - d, 29 + d, 29 + d);
  });

  it('maps back to natural coordinates by 1/scale', () => {
    // Block (8,8)–(23,23): center-span rect 15×15, d = 225 × 1.4 / 60 = 5.25
    // → (2.75,2.75)–(28.25,28.25) at prob-map scale, doubled by 1/0.5.
    const polys = postprocessDb(probMap(64, 64, [{ x0: 8, y0: 8, x1: 23, y1: 23, v: 1 }]), 64, 64, 0.5);
    expect(polys.length).toBe(1);
    expectRect(polys[0], 5.5, 5.5, 56.5, 56.5);
  });

  it('finds two components as two polygons', () => {
    const polys = postprocessDb(
      probMap(64, 64, [
        { x0: 8, y0: 8, x1: 23, y1: 15, v: 1 },
        { x0: 8, y0: 40, x1: 23, y1: 55, v: 1 },
      ]),
      64,
      64,
      1,
    );
    expect(polys.length).toBe(2);
  });

  it('applies the area, short-side, box-thresh and 0.5-score filters', () => {
    const polys = postprocessDb(
      probMap(100, 100, [
        { x0: 2, y0: 2, x1: 4, y1: 4, v: 1 }, // 3×3 = 9 px < area 16
        { x0: 10, y0: 2, x1: 21, y1: 3, v: 1 }, // 2×12 = 24 px, short side 2 < 3
        { x0: 30, y0: 2, x1: 39, y1: 11, v: DB_THRESH }, // score 0.2: strictly above thresh fails
        { x0: 50, y0: 2, x1: 59, y1: 11, v: 0.3 }, // score < box_thresh 0.45
        { x0: 70, y0: 2, x1: 79, y1: 11, v: DB_BOX_THRESH }, // ≥ box_thresh but < 0.5
        { x0: 2, y0: 30, x1: 11, y1: 39, v: DB_MIN_SCORE }, // boundary: 0.5 is kept
      ]),
      100,
      100,
      1,
    );
    expect(polys.length).toBe(1);
    expect(polys[0].score).toBeCloseTo(DB_MIN_SCORE, 6);
  });

  it(`caps candidates at ${DB_MAX_CANDIDATES}`, () => {
    // 3001 blocks of 4×4 at pitch 6 (rows 0..3, gap rows/cols 4..5).
    const w = 6 * (DB_MAX_CANDIDATES + 1);
    const blocks = Array.from({ length: DB_MAX_CANDIDATES + 1 }, (_, k) => ({
      x0: 6 * k,
      y0: 0,
      x1: 6 * k + 3,
      y1: 3,
      v: 1,
    }));
    const polys = postprocessDb(probMap(w, 6, blocks), w, 6, 1);
    expect(polys.length).toBe(DB_MAX_CANDIDATES);
    expect(polys.every((p) => p.score === 1)).toBe(true);
  });
});
