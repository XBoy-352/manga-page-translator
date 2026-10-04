import { describe, expect, it } from 'vitest';
import {
  buildCharset,
  buildRecBatch,
  decodeCtc,
  preprocessRec,
  REC_MAX_BATCH,
  recognizeCrops,
  rotateCrop,
  TALL_ASPECT,
  type RecPre,
} from '../src/core/rec';

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

/** Hand-built "logits": T×C matrix, one picked class with its prob per step. */
function oneHot(T: number, C: number, picks: Array<[index: number, prob: number]>): Float32Array {
  const x = new Float32Array(T * C);
  picks.forEach(([idx, prob], t) => {
    x[t * C + idx] = prob;
  });
  return x;
}

describe('decodeCtc (SPEC §7.4)', () => {
  const charset = ['blank', 'a', 'b', 'c', ' '];

  it('collapses repeats, drops blanks and keeps spaces; scores the emitted steps', () => {
    // 'a' 0.9 → 'a' 0.8 (repeat, collapsed) → blank → ' ' 0.5.
    const r = decodeCtc(oneHot(4, 5, [[1, 0.9], [1, 0.8], [0, 1], [4, 0.5]]), 4, 5, charset);
    expect(r.text).toBe('a ');
    expect(r.score).toBeCloseTo((0.9 + 0.5) / 2, 6); // probs round-trip through f32
  });

  it('lets a blank break a repeat run', () => {
    const r = decodeCtc(oneHot(3, 5, [[1, 0.9], [0, 1], [1, 0.8]]), 3, 5, charset);
    expect(r.text).toBe('aa');
    expect(r.score).toBeCloseTo((0.9 + 0.8) / 2, 6);
  });

  it('returns an empty result when every step is blank', () => {
    const r = decodeCtc(oneHot(2, 5, [[0, 1], [0, 1]]), 2, 5, charset);
    expect(r.text).toBe('');
    expect(r.score).toBe(0);
  });
});

describe('buildCharset (SPEC §7.4)', () => {
  it('builds ["blank", ...dict lines, " "] from a fixture dict string', () => {
    expect(buildCharset('X\nY\nZ\n')).toEqual(['blank', 'X', 'Y', 'Z', ' ']);
  });

  it('handles \r\n line endings and drops empty lines and a BOM', () => {
    expect(buildCharset('A\r\nB\n\nC')).toEqual(['blank', 'A', 'B', 'C', ' ']);
    expect(buildCharset('\uFEFFあ\nい')).toEqual(['blank', 'あ', 'い', ' ']);
  });
});

describe('preprocessRec (SPEC §7.4)', () => {
  it('resizes to height 48, normalizes RGB with (x − 0.5)/0.5', () => {
    // 24×48 crop → width round(48 × 24/48) = 24.
    const pre = preprocessRec(makeImage(24, 48, (x, y) => (x === 0 && y === 0 ? [255, 0, 127, 255] : [0, 0, 0, 255])));
    expect(pre.w).toBe(24);
    expect(pre.x.length).toBe(3 * 48 * 24);
    const plane = 48 * 24;
    expect(pre.x[0]).toBeCloseTo((255 / 255 - 0.5) / 0.5, 6); // R
    expect(pre.x[plane]).toBeCloseTo((0 / 255 - 0.5) / 0.5, 6); // G
    expect(pre.x[2 * plane]).toBeCloseTo((127 / 255 - 0.5) / 0.5, 6); // B
    expect(pre.x[1]).toBeCloseTo((0 / 255 - 0.5) / 0.5, 6); // next pixel
  });

  it('clamps the resized width to [8, 320]', () => {
    expect(preprocessRec(makeImage(960, 48)).w).toBe(320); // round(48 × 20) → clamp
    expect(preprocessRec(makeImage(4, 48)).w).toBe(8);
    expect(preprocessRec(makeImage(48, 48)).w).toBe(48);
  });
});

describe('buildRecBatch (§7.4: padded to the batch max width)', () => {
  it('pads each crop to the batch max width with zeros', () => {
    const a: RecPre = { x: Float32Array.from({ length: 3 * 48 * 10 }, (_, i) => i), w: 10 };
    const b: RecPre = { x: Float32Array.from({ length: 3 * 48 * 24 }, (_, i) => -i), w: 24 };
    const batch = buildRecBatch([a, b]);
    expect(batch.w).toBe(24);
    expect(batch.x.length).toBe(2 * 3 * 48 * 24);
    const plane = 48 * 24;
    // Crop a occupies columns 0..9; columns 10..23 are zero padding.
    expect(batch.x[0 * 3 * plane + 0 * plane + 0 * 24 + 9]).toBe(9); // last real column
    expect(batch.x[0 * 3 * plane + 0 * plane + 0 * 24 + 10]).toBe(0); // first padded column
    expect(batch.x[0 * 3 * plane + 2 * plane + 47 * 24 + 23]).toBe(0);
    // Crop b is copied through unchanged (all 24 columns).
    expect(batch.x[1 * 3 * plane + 1 * plane + 5 * 24 + 12]).toBe(-(1 * 48 * 24 + 5 * 24 + 12));
  });
});

describe('rotateCrop (§7.4 tall-crop rotations)', () => {
  it('rotates 90° clockwise and 270°, swapping dimensions', () => {
    const strip = makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, 255] : [40, 50, 60, 255]));
    const cw = rotateCrop(strip, 90);
    expect(cw.width).toBe(1);
    expect(cw.height).toBe(2);
    // 'A B' rotated CW points down: A on top, B at the bottom.
    expect([cw.data[0], cw.data[1], cw.data[2]]).toEqual([10, 20, 30]);
    expect([cw.data[4], cw.data[5], cw.data[6]]).toEqual([40, 50, 60]);
    const ccw = rotateCrop(strip, 270);
    expect(ccw.width).toBe(1);
    expect(ccw.height).toBe(2);
    // …and CCW points up: B on top, A at the bottom.
    expect([ccw.data[0], ccw.data[1], ccw.data[2]]).toEqual([40, 50, 60]);
    expect([ccw.data[4], ccw.data[5], ccw.data[6]]).toEqual([10, 20, 30]);
  });
});

describe('recognizeCrops (§7.4 batching + tall-crop rotation)', () => {
  const charset = buildCharset('W\nX\nY\nZ'); // ['blank', 'W', 'X', 'Y', 'Z', ' ']

  /** Fake rec model: row b decodes to picks[b] = [charIndex, prob] in 2 steps. */
  function fakeRunner(rows: Array<[number, number]>) {
    const calls: Array<{ batch: number; width: number; height: number }> = [];
    return {
      calls,
      runner: async (input: { dims: readonly number[]; data: Float32Array }) => {
        const [batch, , height, width] = input.dims;
        calls.push({ batch, width, height });
        const C = charset.length;
        const T = 2;
        const data = new Float32Array(batch * T * C);
        for (let b = 0; b < batch; b++) {
          const [idx, prob] = rows[b];
          data[b * T * C + idx] = prob; // step 0: the character
          data[b * T * C + C + 0] = 1; // step 1: blank
        }
        return {
          out: { dims: [batch, T, C] as number[], data },
        };
      },
    };
  }

  it('recognizes tall crops at 0°, 90° and 270° and keeps the best score', async () => {
    const wide = makeImage(32, 16); // h/w = 0.5 — one variant only
    const tall = makeImage(16, 32); // h/w = 2 ≥ 1.6 — three variants
    const f = fakeRunner([
      [1, 0.8], // wide 0°      → 'W' 0.8
      [2, 0.6], // tall 0°      → 'X' 0.6
      [3, 0.9], // tall 90°     → 'Y' 0.9  (winner)
      [4, 0.3], // tall 270°    → 'Z' 0.3
    ]);
    const results = await recognizeCrops(f.runner, [wide, tall], charset);
    expect(results[0].text).toBe('W');
    expect(results[0].score).toBeCloseTo(0.8, 6);
    expect(results[1].text).toBe('Y');
    expect(results[1].score).toBeCloseTo(0.9, 6);
    // One batch of 4 variants (1 + 3).
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].batch).toBe(4);
  });

  it(`splits variants into chunks of at most ${REC_MAX_BATCH}`, async () => {
    const crops = Array.from({ length: REC_MAX_BATCH + 1 }, () => makeImage(32, 16));
    const f = fakeRunner(Array.from({ length: REC_MAX_BATCH + 1 }, () => [1, 0.7] as [number, number]));
    const results = await recognizeCrops(f.runner, crops, charset);
    expect(f.calls.length).toBe(2);
    expect(f.calls[0].batch).toBe(REC_MAX_BATCH);
    expect(f.calls[1].batch).toBe(1);
    expect(results.length).toBe(REC_MAX_BATCH + 1);
    expect(results.every((r) => r.text === 'W' && Math.abs(r.score - 0.7) < 1e-6)).toBe(true);
  });

  it(`only rotates crops with h/w ≥ ${TALL_ASPECT}`, async () => {
    const boundaryWide = makeImage(32, 48); // h/w = 1.5 — not tall
    const boundaryTall = makeImage(30, 48); // h/w = 1.6 — tall
    const f = fakeRunner(Array.from({ length: 4 }, () => [2, 0.9] as [number, number]));
    await recognizeCrops(f.runner, [boundaryWide, boundaryTall], charset);
    expect(f.calls[0].batch).toBe(4); // 1 + 3 variants
  });
});
