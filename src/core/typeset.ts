// Typesetting engine — SPEC §7.8.
// Draws translated strings into a balloon's bbox using the bundled Comic Neue
// Bold font (OFL), registered via the FontFace constructor in the worker.

export const FONT_FAMILY = 'Comic Neue Bold';
export const FONT_WEIGHT = 'bold';

const INSET_PX = 4;
const MIN_FONT_SIZE = 9;
const WRAP_WIDTH_HEIGHT_FACTOR = 1.6; // wrap width = min(bboxW, 1.6 × bboxH)
const START_SIZE_HEIGHT_FACTOR = 0.9; // start font size = 0.9 × bboxH / estimated lines
const LINE_HEIGHT = 1.2; // assumption taken — SPEC §7.8 does not define leading; see docs/ASSUMPTIONS.md

/**
 * Build a FontFace from downloaded font bytes and register it in the current
 * global scope (works for both window and worker callers).
 */
export async function registerFont(bytes: ArrayBuffer): Promise<FontFace> {
  const font = new FontFace(FONT_FAMILY, bytes, { weight: FONT_WEIGHT });
  await font.load();
  const fontSet = (globalThis as { fonts?: FontFaceSet }).fonts;
  fontSet?.add(font);
  return font;
}

/**
 * Draw `translations` inside `balloon.bbox` ([x0, y0, x1, y1]). The structural
 * subset of Balloon (SPEC §7.5) is intentional — any Balloon satisfies it.
 * Never truncates text: at the 9 px floor the text overflows the box instead.
 */
export function typeset(
  ctx: OffscreenCanvasRenderingContext2D,
  balloon: { bbox: [number, number, number, number] },
  translations: string[],
  font: FontFace,
): void {
  const [bx0, by0, bx1, by1] = balloon.bbox;
  const innerX = bx0 + INSET_PX;
  const innerY = by0 + INSET_PX;
  const innerW = Math.max(0, bx1 - bx0 - 2 * INSET_PX);
  const innerH = Math.max(0, by1 - by0 - 2 * INSET_PX);
  const wrapWidth = Math.min(innerW, WRAP_WIDTH_HEIGHT_FACTOR * innerH);

  // assumption taken — "estimated lines" (SPEC §7.8) is read as one initial
  // line per provided string; the shrink loop corrects underestimates.
  const estimatedLines = Math.max(1, translations.length);
  // assumption taken — clamped to ≥ 1 px so a degenerate translation count
  // cannot produce an invalid 0 px CSS font; the 9 px shrink floor is unaffected.
  let fontSize = Math.max(1, Math.floor((START_SIZE_HEIGHT_FACTOR * innerH) / estimatedLines));

  let lines = wrapAll(ctx, font, translations, fontSize, wrapWidth);
  while (lines.length * lineHeight(fontSize) > innerH && fontSize > MIN_FONT_SIZE) {
    fontSize -= 1;
    lines = wrapAll(ctx, font, translations, fontSize, wrapWidth);
  }

  draw(ctx, font, fontSize, lines, innerX, innerY, innerW, innerH);
}

function lineHeight(fontSize: number): number {
  return LINE_HEIGHT * fontSize;
}

function fontShorthand(font: FontFace, px: number): string {
  return `${font.weight} ${px}px "${font.family}"`;
}

/** Greedy word-wrap of every paragraph at `fontSize`; sets ctx.font for measuring. */
function wrapAll(
  ctx: OffscreenCanvasRenderingContext2D,
  font: FontFace,
  paragraphs: string[],
  fontSize: number,
  maxWidth: number,
): string[] {
  ctx.font = fontShorthand(font, fontSize);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    for (const line of wrapParagraph(ctx, paragraph, maxWidth)) {
      lines.push(line);
    }
  }
  return lines;
}

function wrapParagraph(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [text]; // empty string keeps its one line
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    // a word wider than maxWidth still gets its own line (never split, never dropped)
    if (current === '' || ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  font: FontFace,
  fontSize: number,
  lines: string[],
  innerX: number,
  innerY: number,
  innerW: number,
  innerH: number,
): void {
  const lh = lineHeight(fontSize);
  const blockH = lines.length * lh;
  // assumption taken — an overflowing block (9 px floor reached) is top-aligned
  // at the inset top so it spills downward only; a fitting block is centered.
  const blockTop = innerY + Math.max(0, (innerH - blockH) / 2);

  ctx.font = fontShorthand(font, fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, 0.08 * fontSize);
  ctx.strokeStyle = 'rgba(20,20,20,0.9)';
  ctx.fillStyle = '#ffffff';

  const cx = innerX + innerW / 2;
  for (let i = 0; i < lines.length; i++) {
    const y = blockTop + (i + 0.5) * lh;
    ctx.strokeText(lines[i], cx, y); // stroke then fill (SPEC §7.8)
    ctx.fillText(lines[i], cx, y);
  }
}
