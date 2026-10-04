import { describe, expect, it } from 'vitest';
import { buildMask } from '../src/core/inpaint/mask';
import { inpaintTelea } from '../src/core/inpaint/telea';
import { inpaintLama, type LamaPatchInput } from '../src/core/inpaint/lama';

// Node has no ImageData global; install a structural polyfill so the pure
// modules can be exercised. Browsers/workers provide the real global.
type ImageDataCtor = new (data: Uint8ClampedArray, width: number, height: number) => ImageData;
const g = globalThis as unknown as { ImageData?: ImageDataCtor };
if (typeof g.ImageData !== 'function') {
  class ImageDataPolyfill {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      if (data.length !== width * height * 4) throw new Error('bad ImageData size');
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  g.ImageData = ImageDataPolyfill as unknown as ImageDataCtor;
}
const ImageDataCtor = g.ImageData as ImageDataCtor;

function makeImage(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, gg, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = gg;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return new ImageDataCtor(data, w, h);
}

function fillRect(mask: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) mask[y * w + x] = 255;
  }
}

function at(img: ImageData, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// Deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildMask (§7.7)', () => {
  const rect: { pts: [number, number][] }[] = [{ pts: [[50, 50], [150, 50], [150, 150], [50, 150]] }];
  const W = 200, H = 200;

  it('rasterizes fill + 4px stroke (pad 0)', () => {
    const m = buildMask(rect, W, H, { strokePx: 4, padPx: 0 });
    expect(m.length).toBe(W * H);
    expect(at0(m, 100, 100)).toBe(255); // filled interior
    expect(at0(m, 48, 100)).toBe(255); // 2px outside left edge (stroke)
    expect(at0(m, 47, 100)).toBe(0); // 3px outside — beyond stroke
    expect(at0(m, 151, 100)).toBe(255);
    expect(at0(m, 152, 100)).toBe(0);
    expect(at0(m, 100, 48)).toBe(255);
    expect(at0(m, 100, 47)).toBe(0);
    expect(at0(m, 100, 151)).toBe(255);
    expect(at0(m, 100, 152)).toBe(0);
    expect(at0(m, 49, 49)).toBe(255); // round join covers the corner
  });

  it('dilates by padPx with a separable two-pass max filter (square SE)', () => {
    const m = buildMask(rect, W, H, { strokePx: 4, padPx: 24 });
    // stroke spans 48..151; dilation by 24 → 24..175
    expect(at0(m, 100, 100)).toBe(255);
    expect(at0(m, 100, 24)).toBe(255);
    expect(at0(m, 100, 23)).toBe(0);
    expect(at0(m, 100, 175)).toBe(255);
    expect(at0(m, 100, 176)).toBe(0);
    expect(at0(m, 24, 100)).toBe(255);
    expect(at0(m, 23, 100)).toBe(0);
    expect(at0(m, 175, 100)).toBe(255);
    expect(at0(m, 176, 100)).toBe(0);
    // Square structuring element: (25,30) is Chebyshev-23 from the mask corner
    // (48,48) → filled, even though its Euclidean distance is ≈29 (> 24).
    expect(at0(m, 25, 30)).toBe(255);
    expect(at0(m, 23, 23)).toBe(0);
  });

  it('defaults to strokePx 4 and padPx 24', () => {
    expect(buildMask(rect, W, H)).toEqual(buildMask(rect, W, H, { strokePx: 4, padPx: 24 }));
  });

  it('uses only 0 and 255, and is empty without polygons', () => {
    const m = buildMask(rect, W, H);
    expect(new Set(m)).toEqual(new Set([0, 255]));
    const empty = buildMask([], W, H);
    expect(empty.every((v) => v === 0)).toBe(true);
  });
});

function at0(m: Uint8Array, x: number, y: number): number {
  return m[y * 200 + x];
}

describe('inpaintTelea invariants (§7.7, §11)', () => {
  it('leaves unmasked pixels bit-identical', () => {
    const w = 64, h = 48;
    const rand = rng(1234);
    const img = makeImage(w, h, () => {
      const v = Math.floor(rand() * 256);
      return [v, (v + 37) % 256, (v + 91) % 256, 255];
    });
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 20, 10, 40, 30);
    fillRect(mask, w, 2, 40, 8, 46);
    fillRect(mask, w, 0, 0, 9, 5); // touches the image border (generic path)
    const out = inpaintTelea(img, mask, 3);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] !== 0) continue;
        expect(at(out, x, y)).toEqual(at(img, x, y));
      }
    }
  });

  it('produces no NaN (uniform image fills back to the uniform value)', () => {
    const w = 40, h = 40;
    const img = makeImage(w, h, () => [200, 200, 200, 255]);
    const mask = new Uint8Array(w * h);
    // Solid disk of radius 10 — every neighbour equal, gradient terms zero.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x - 20) * (x - 20) + (y - 20) * (y - 20) <= 100) mask[y * w + x] = 255;
      }
    }
    const out = inpaintTelea(img, mask, 3);
    let sum = 0, n = 0, maxDrift = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] === 0) continue;
        const px = at(out, x, y);
        for (let c = 0; c < 3; c++) {
          expect(Number.isFinite(px[c])).toBe(true);
          maxDrift = Math.max(maxDrift, Math.abs(px[c] - 200));
          sum += px[c];
          n++;
        }
        expect(px[3]).toBe(255); // alpha fills from surrounding alpha
      }
    }
    // NaN would clamp to 0 (200 away from the uniform value). Per-pixel drift
    // is rounding jitter mildly amplified by the gradient term (OpenCV's f32
    // accumulation shows the same class of noise); it must stay small and
    // must average out.
    expect(maxDrift).toBeLessThanOrEqual(3);
    expect(Math.abs(sum / n - 200)).toBeLessThanOrEqual(1);
  });

  it('fills nothing when the whole image is masked (no narrow band exists)', () => {
    const w = 16, h = 16;
    const img = makeImage(w, h, (x, y) => [x * 4, y * 4, 128, 255]);
    const mask = new Uint8Array(w * h).fill(255);
    const out = inpaintTelea(img, mask, 3);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });

  it('reconstructs a smooth field better than a trivial mean fill (plausible diffusion)', () => {
    const w = 64, h = 48;
    // Smooth analytic field — what a diffusion would rebuild from the boundary.
    const field = (x: number, y: number): number => 128 + 60 * Math.sin((2 * Math.PI * x) / 64) * Math.cos((2 * Math.PI * y) / 48);
    const img = makeImage(w, h, (x, y) => {
      const v = Math.round(field(x, y));
      return [v, v, v, 255];
    });
    const x0 = 24, x1 = 39, y0 = 18, y1 = 29; // 16×12 hole
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, x0, y0, x1, y1);
    const out = inpaintTelea(img, mask, 3);

    // Trivial mean fill: constant = mean of the 1px boundary ring.
    let sum = 0, n = 0;
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const onRing = y === y0 - 1 || y === y1 + 1 || x === x0 - 1 || x === x1 + 1;
        if (!onRing) continue;
        sum += field(x, y);
        n++;
      }
    }
    const mean = sum / n;

    let teleaErr = 0, meanErr = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ref = field(x, y);
        const got = at(out, x, y)[0];
        teleaErr += (got - ref) * (got - ref);
        meanErr += (mean - ref) * (mean - ref);
      }
    }
    expect(teleaErr).toBeLessThan(meanErr / 3);
  });

  it('fills a single-pixel hole from its neighbourhood without NaN', () => {
    const w = 9, h = 9;
    const img = makeImage(w, h, () => [77, 88, 99, 255]);
    const mask = new Uint8Array(w * h);
    mask[4 * w + 4] = 255;
    const out = inpaintTelea(img, mask, 3);
    const px = at(out, 4, 4);
    for (let c = 0; c < 3; c++) expect(Math.abs(px[c] - [77, 88, 99][c])).toBeLessThanOrEqual(1);
    expect(px[3]).toBe(255);
  });

  it('clamps radius into [1, 100] like OpenCV', () => {
    const w = 12, h = 12;
    const img = makeImage(w, h, () => [10, 20, 30, 255]);
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 4, 4, 7, 7);
    expect(() => inpaintTelea(img, mask, 0)).not.toThrow();
    expect(() => inpaintTelea(img, mask, 1000)).not.toThrow();
  });
});

describe('inpaintLama patching (§7.7)', () => {
  interface Call { width: number; height: number; image: Float32Array; mask: Float32Array }
  function fakeRunner(calls: Call[]): (p: LamaPatchInput) => Promise<Float32Array> {
    return async (p) => {
      calls.push({ width: p.width, height: p.height, image: p.image, mask: p.mask });
      const out = new Float32Array(3 * p.height * p.width).fill(0.5);
      return out;
    };
  }

  it('snaps patch size up to 64-multiples with 64px context and never runs the full page', async () => {
    const w = 256, h = 256;
    const img = makeImage(w, h, (x, y) => [(x + y) % 256, 10, 20, 255]);
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 100, 100, 107, 107); // 8×8 blob
    const calls: Call[] = [];
    const out = await inpaintLama(img, mask, fakeRunner(calls));
    expect(calls.length).toBe(1);
    const c = calls[0];
    // bbox 8×8 + 2×64 context = 136 → snapped UP to 192
    expect(c.width).toBe(192);
    expect(c.height).toBe(192);
    expect(c.width % 64).toBe(0);
    expect(c.height % 64).toBe(0);
    // never the full page
    expect(c.width).toBeLessThan(w);
    expect(c.height).toBeLessThan(h);
    // tensors sized correctly, values normalized
    expect(c.image.length).toBe(3 * c.height * c.width);
    expect(c.mask.length).toBe(c.height * c.width);
    let imgMin = Infinity, imgMax = -Infinity;
    for (let i = 0; i < c.image.length; i++) {
      imgMin = Math.min(imgMin, c.image[i]);
      imgMax = Math.max(imgMax, c.image[i]);
    }
    expect(imgMin).toBeGreaterThanOrEqual(0);
    expect(imgMax).toBeLessThanOrEqual(1);
    expect(new Set(c.mask)).toEqual(new Set([0, 1]));
    // composite: hole pixels take the fake output (0.5 → 128), rest unchanged
    expect(at(out, 103, 103)).toEqual([128, 128, 128, 255]);
    expect(at(out, 50, 50)).toEqual(at(img, 50, 50));
  });

  it('runs one patch per connected component and composites only where mask = 255', async () => {
    const w = 256, h = 256;
    const img = makeImage(w, h, (x, y) => [x % 256, y % 256, 7, 255]);
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 20, 20, 27, 27);
    fillRect(mask, w, 200, 200, 207, 207);
    const calls: Call[] = [];
    const out = await inpaintLama(img, mask, fakeRunner(calls));
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.width % 64).toBe(0);
      expect(c.height % 64).toBe(0);
    }
    // each patch's mask tensor marks exactly its own component's pixels
    for (const c of calls) {
      let holes = 0;
      for (let i = 0; i < c.mask.length; i++) if (c.mask[i] === 1) holes++;
      expect(holes).toBe(64); // 8×8 blob per component
    }
    expect(at(out, 24, 24)).toEqual([128, 128, 128, 255]);
    expect(at(out, 204, 204)).toEqual([128, 128, 128, 255]);
    expect(at(out, 100, 100)).toEqual(at(img, 100, 100));
  });

  it('does nothing on an empty mask (session never called)', async () => {
    const w = 32, h = 32;
    const img = makeImage(w, h, () => [1, 2, 3, 255]);
    const mask = new Uint8Array(w * h);
    const calls: Call[] = [];
    const out = await inpaintLama(img, mask, fakeRunner(calls));
    expect(calls.length).toBe(0);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });

  it('requires an injected session runner', async () => {
    const img = makeImage(8, 8, () => [0, 0, 0, 255]);
    await expect(inpaintLama(img, new Uint8Array(64))).rejects.toThrow(/session runner/);
  });
});
