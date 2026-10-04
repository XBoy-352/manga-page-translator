import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFont, typeset } from '../src/core/typeset';

// Stub 2D context: measureText derives width from the px in ctx.font as
// `length × px × 0.5`, so wrap/shrink outcomes are fully deterministic.
interface DrawCall {
  op: 'stroke' | 'fill';
  text: string;
  x: number;
  y: number;
}

interface CtxProps {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  textAlign: string;
  textBaseline: string;
}

function makeCtx() {
  const calls: DrawCall[] = [];
  const props: CtxProps = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
  };
  const ctx = {
    get font(): string {
      return props.font;
    },
    set font(value: string) {
      props.font = value;
    },
    get fillStyle(): string {
      return props.fillStyle;
    },
    set fillStyle(value: string) {
      props.fillStyle = value;
    },
    get strokeStyle(): string {
      return props.strokeStyle;
    },
    set strokeStyle(value: string) {
      props.strokeStyle = value;
    },
    get lineWidth(): number {
      return props.lineWidth;
    },
    set lineWidth(value: number) {
      props.lineWidth = value;
    },
    get lineJoin(): string {
      return props.lineJoin;
    },
    set lineJoin(value: string) {
      props.lineJoin = value;
    },
    get textAlign(): string {
      return props.textAlign;
    },
    set textAlign(value: string) {
      props.textAlign = value;
    },
    get textBaseline(): string {
      return props.textBaseline;
    },
    set textBaseline(value: string) {
      props.textBaseline = value;
    },
    measureText(text: string): { width: number } {
      const m = /(\d+(?:\.\d+)?)px/.exec(props.font);
      const px = m ? parseFloat(m[1]) : 10;
      return { width: text.length * px * 0.5 };
    },
    strokeText(text: string, x: number, y: number): void {
      calls.push({ op: 'stroke', text, x, y });
    },
    fillText(text: string, x: number, y: number): void {
      calls.push({ op: 'fill', text, x, y });
    },
  } as unknown as OffscreenCanvasRenderingContext2D;
  return { ctx, calls, props };
}

const font = { family: 'Comic Neue Bold', weight: 'bold' } as unknown as FontFace;

describe('typeset', () => {
  it('applies the §7.8 style and centers a single line (stroke before fill)', () => {
    // bbox [10,10,210,110] → inset box x:14..206, y:14..106 (192×92)
    // wrapWidth = min(192, 1.6×92=147.2) = 147.2; start = floor(0.9×92/1) = 82;
    // 1.2×82 > 92 → shrink to 76 (1.2×76 = 91.2 ≤ 92).
    const { ctx, calls, props } = makeCtx();
    typeset(ctx, { bbox: [10, 10, 210, 110] }, ['Hi'], font);

    expect(props.font).toBe('bold 76px "Comic Neue Bold"');
    expect(props.fillStyle).toBe('#ffffff');
    expect(props.strokeStyle).toBe('rgba(20,20,20,0.9)');
    expect(props.lineJoin).toBe('round');
    expect(props.lineWidth).toBeCloseTo(Math.max(1.5, 0.08 * 76), 10);
    expect(props.textAlign).toBe('center');
    expect(props.textBaseline).toBe('middle');

    expect(calls).toHaveLength(2);
    expect(calls[0].op).toBe('stroke'); // stroke then fill
    expect(calls[1].op).toBe('fill');
    expect(calls[0].text).toBe('Hi');
    expect(calls[0].x).toBe(110); // horizontal center of inset box
    expect(calls[0].y).toBeCloseTo(60, 5); // vertical center of inset box
  });

  it('greedy word-wraps and re-wraps while shrinking', () => {
    // bbox [0,0,300,300] → inset 292×292, wrapWidth 292; estimated 2 lines →
    // start = floor(0.9×292/2) = 131. At 131 'aaa bbb' (7×131×0.5 = 458.5 > 292)
    // wraps to 3 lines → too tall → shrink. At 83 'aaa bbb' (290.5 ≤ 292) fits
    // one line → 2 lines × 99.6 = 199.2 ≤ 292 → stop.
    const { ctx, calls, props } = makeCtx();
    typeset(ctx, { bbox: [0, 0, 300, 300] }, ['aaa bbb', 'ccc'], font);

    expect(props.font).toBe('bold 83px "Comic Neue Bold"');
    const filled = calls.filter((c) => c.op === 'fill');
    expect(filled.map((c) => c.text)).toEqual(['aaa bbb', 'ccc']); // 2 wrapped lines, re-wrapped at final size
    expect(calls).toHaveLength(4); // each line stroked + filled
    expect(filled[0].x).toBe(150); // 4 + 292/2
    expect(filled[1].x).toBe(150); // every line centered horizontally
    expect(filled[1].y - filled[0].y).toBeCloseTo(1.2 * 83, 5); // one lineHeight apart
    const blockTop = 4 + (292 - 2 * 1.2 * 83) / 2;
    expect(filled[0].y).toBeCloseTo(blockTop + 0.5 * 1.2 * 83, 5); // block vertically centered
  });

  it('never truncates: at the 9 px floor overflowing text is still drawn', () => {
    // bbox [0,0,50,20] → inset 42×12, wrapWidth min(42, 19.2) = 19.2;
    // start = floor(0.9×12) = 10; both words exceed 19.2 even at 9 px →
    // 2 lines × 10.8 = 21.6 > 12 → overflow drawn, nothing dropped.
    const { ctx, calls, props } = makeCtx();
    typeset(ctx, { bbox: [0, 0, 50, 20] }, ['hello world'], font);

    expect(props.font).toBe('bold 9px "Comic Neue Bold"'); // floor respected
    const filled = calls.filter((c) => c.op === 'fill');
    expect(filled.map((c) => c.text)).toEqual(['hello', 'world']); // full text present
    const blockBottom = filled[1].y + 0.5 * 1.2 * 9;
    expect(blockBottom).toBeGreaterThan(16); // spills past the inset box bottom (4+12)
  });

  it('wraps into min(bboxW, 1.6 × bboxH), not the full bbox width', () => {
    // bbox [0,0,200,50] → inset 192×42 but wrapWidth = min(192, 67.2) = 67.2.
    // 'abcdef' is 6×f×0.5 wide: fits 192 already at start 37 (111 ≤ 192), but
    // the cap forces shrink to 35 (1.2×35 = 42 ≤ 42) — proving the cap is used.
    const { ctx, calls, props } = makeCtx();
    typeset(ctx, { bbox: [0, 0, 200, 50] }, ['abcdef'], font);

    expect(props.font).toBe('bold 35px "Comic Neue Bold"');
    expect(calls.filter((c) => c.op === 'fill').map((c) => c.text)).toEqual(['abcdef']);
  });

  it('draws nothing for an empty translation list', () => {
    const { ctx, calls } = makeCtx();
    typeset(ctx, { bbox: [0, 0, 100, 100] }, [], font);
    expect(calls).toHaveLength(0);
  });
});

describe('registerFont', () => {
  class FakeFontFace {
    static constructed: { family: string; source: unknown; weight: string | undefined }[] = [];
    static nextLoadRejects = false;
    family: string;
    weight: string;
    status = 'unloaded';

    constructor(family: string, source: unknown, descriptors?: { weight?: string }) {
      FakeFontFace.constructed.push({ family, source, weight: descriptors?.weight });
      this.family = family;
      this.weight = descriptors?.weight ?? 'normal';
    }

    load(): Promise<FakeFontFace> {
      if (FakeFontFace.nextLoadRejects) {
        return Promise.reject(new Error('font decode failed'));
      }
      this.status = 'loaded';
      return Promise.resolve(this);
    }
  }

  const fontSet = {
    added: [] as unknown[],
    add(f: unknown): void {
      this.added.push(f);
    },
  };

  afterEach(() => {
    FakeFontFace.constructed = [];
    FakeFontFace.nextLoadRejects = false;
    fontSet.added = [];
    vi.unstubAllGlobals();
  });

  it('constructs Comic Neue Bold (bold) from the bytes, loads it, and registers it', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('fonts', fontSet);
    const bytes = new ArrayBuffer(8);

    const fontFace = await registerFont(bytes);

    expect(FakeFontFace.constructed).toHaveLength(1);
    expect(FakeFontFace.constructed[0].family).toBe('Comic Neue Bold');
    expect(FakeFontFace.constructed[0].source).toBe(bytes);
    expect(FakeFontFace.constructed[0].weight).toBe('bold');
    expect(fontFace.family).toBe('Comic Neue Bold');
    expect(fontFace.weight).toBe('bold');
    expect(fontFace.status).toBe('loaded');
    expect(fontSet.added).toEqual([fontFace]);
  });

  it('propagates load failure without registering', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('fonts', fontSet);
    FakeFontFace.nextLoadRejects = true;

    await expect(registerFont(new ArrayBuffer(4))).rejects.toThrow('font decode failed');
    expect(fontSet.added).toHaveLength(0);
  });
});
