import { describe, expect, it } from 'vitest';
import { clusterBalloons, type Line } from '../src/core/cluster';

/** Axis-aligned synthetic line centered at (cx, cy) with the given height. */
function line(cx: number, cy: number, h: number, w = 2 * h): Line {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  return {
    poly: {
      pts: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      score: 0.9,
    },
    text: 'あ',
    score: 0.9,
    cx,
    cy,
    h,
  };
}

describe('clusterBalloons — MST clustering', () => {
  it('joins nearby lines into one balloon and keeps distant singletons', () => {
    const a = line(100, 100, 10);
    const b = line(108, 100, 10); // 8 ≤ T = 2.5 × 10 = 25
    const far = line(500, 500, 10); // far beyond T
    const balloons = clusterBalloons([a, b, far], 'ltr');

    expect(balloons).toHaveLength(2);
    const pair = balloons.find((bl) => bl.lines.length === 2);
    expect(pair).toBeDefined();
    expect(pair!.lines.map((l) => l.cx).sort((x, y) => x - y)).toEqual([100, 108]);
    const single = balloons.find((bl) => bl.lines.length === 1);
    expect(single!.lines[0]).toBe(far); // singleton stays a balloon
  });

  it('merges via MST edges, not direct pairwise distance', () => {
    // Chain A-B=10, B-C=20; direct A-C=30 exceeds nothing here but is not an
    // MST edge — the components must still merge through the chain.
    const a = line(0, 0, 10);
    const b = line(10, 0, 10);
    const c = line(30, 0, 10);
    const balloons = clusterBalloons([a, b, c], 'ltr');
    expect(balloons).toHaveLength(1);
    expect(balloons[0].lines).toHaveLength(3);
  });

  it('drops MST edges longer than 2.5 × median(line.h)', () => {
    const a = line(0, 0, 10);
    const b = line(10, 0, 10); // A-B = 10 ≤ T = 25 → kept
    const c = line(60, 0, 10); // B-C = 50 > T → dropped
    const balloons = clusterBalloons([a, b, c], 'ltr');
    expect(balloons).toHaveLength(2);
    expect(balloons.map((bl) => bl.lines.length).sort((x, y) => x - y)).toEqual([1, 2]);
  });

  it('uses the even-count median for T', () => {
    // median([10, 30]) = 20 → T = 50.
    expect(clusterBalloons([line(0, 0, 10), line(40, 0, 30)], 'ltr')).toHaveLength(1); // 40 ≤ 50
    expect(clusterBalloons([line(0, 0, 10), line(60, 0, 30)], 'ltr')).toHaveLength(2); // 60 > 50
  });

  it('returns [] for no lines and one balloon for a single line', () => {
    expect(clusterBalloons([], 'rtl')).toEqual([]);
    const one = clusterBalloons([line(5, 5, 10)], 'ltr');
    expect(one).toHaveLength(1);
    expect(one[0].lines).toHaveLength(1);
    expect(one[0].order).toBe(0);
  });
});

describe('clusterBalloons — bbox', () => {
  it('is min/max over member polygon points', () => {
    const a = line(100, 100, 10); // x 90..110, y 95..105
    const b = line(108, 100, 10); // x 98..118, y 95..105
    const [balloon] = clusterBalloons([a, b], 'ltr');
    expect(balloon.bbox).toEqual([90, 95, 118, 105]);
  });
});

describe('clusterBalloons — reading order', () => {
  it('orders columns right-to-left for rtl and left-to-right for ltr', () => {
    const left = line(100, 100, 10);
    const right = line(400, 100, 10);

    const rtl = clusterBalloons([left, right], 'rtl');
    expect(rtl.map((b) => b.lines[0].cx)).toEqual([400, 100]);
    expect(rtl.map((b) => b.order)).toEqual([0, 1]);

    const ltr = clusterBalloons([left, right], 'ltr');
    expect(ltr.map((b) => b.lines[0].cx)).toEqual([100, 400]);
    expect(ltr.map((b) => b.order)).toEqual([0, 1]);
  });

  it('orders balloons within a column top-to-bottom', () => {
    // Two single-line balloons stacked vertically share one column (x-gap 0).
    const top = line(100, 100, 10);
    const bottom = line(100, 200, 10);
    const rtl = clusterBalloons([bottom, top], 'rtl');
    expect(rtl.map((b) => b.lines[0].cy)).toEqual([100, 200]);
    const ltr = clusterBalloons([bottom, top], 'ltr');
    expect(ltr.map((b) => b.lines[0].cy)).toEqual([100, 200]);
  });

  it('orders lines inside a balloon right-to-left then top-to-bottom for rtl', () => {
    // Two tategaki-style columns 20 px apart (≤ T = 25) in one balloon.
    const rightCol = line(200, 100, 10);
    const leftCol = line(180, 100, 10);
    const [balloon] = clusterBalloons([leftCol, rightCol], 'rtl');
    expect(balloon.lines).toHaveLength(2);
    expect(balloon.lines.map((l) => l.cx)).toEqual([200, 180]);

    // Equal cx → the top-to-bottom tie-break applies.
    const lower = line(100, 65, 10);
    const upper = line(100, 50, 10);
    const [tied] = clusterBalloons([lower, upper], 'rtl');
    expect(tied.lines.map((l) => l.cy)).toEqual([50, 65]);
  });

  it('orders lines inside a balloon top-to-bottom for ltr', () => {
    const upper = line(100, 50, 10);
    const lower = line(100, 60, 10); // 10 ≤ T → same balloon
    const [balloon] = clusterBalloons([lower, upper], 'ltr');
    expect(balloon.lines).toHaveLength(2);
    expect(balloon.lines.map((l) => l.cy)).toEqual([50, 60]);
  });

  it('assigns 0-based contiguous order across all balloons', () => {
    const lines = [line(100, 100, 10), line(300, 100, 10), line(500, 100, 10)];
    const rtl = clusterBalloons(lines, 'rtl');
    expect(rtl.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(rtl.map((b) => b.lines[0].cx)).toEqual([500, 300, 100]);
  });
});
