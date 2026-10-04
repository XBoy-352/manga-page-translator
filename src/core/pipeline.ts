// Pipeline orchestrator (docs/SPEC.md §6.3, §6.5, §7.1). The stage order
// slice → det → rec → cluster → translate → inpaint → typeset is binding.
// Per-stage timings are measured into `Timings`; translation streams, so a
// balloon's inpaint + typeset start as soon as its line commits (§6.3:
// "Inpainting of a balloon starts as soon as its translation commits") and the
// updated composite is handed to the caller after every painted balloon.
//
// Heavy model work runs in dedicated workers that the caller (background.ts)
// spawns and injects here — this module never imports onnxruntime or
// transformers, it only orchestrates.

import { clusterBalloons, type Balloon, type Line } from './cluster';
import type { Polygon } from './det';
import { buildMask } from './inpaint/mask';
import { inpaintTelea } from './inpaint/telea';
import { REC_MAX_BATCH, type RecResult } from './rec';
import { planSlices, type Slice } from './slice';
import { typeset } from './typeset';
import type { TranslateBackend } from './translate/backend';
import type { ProgressEvent, Settings, SrcLang, Timings } from '../shared/types';

/** §6.5: > 48 tags → sequential chunks of ≤ 48 tags, one stream each. */
const MAX_TAGS_PER_REQUEST = 48;

/**
 * Margin around a balloon bbox for the per-balloon inpaint crop. Covers the
 * §7.7 mask padding (24 px) and LaMa's 64 px patch context.
 */
const INPAINT_CROP_MARGIN = 64;

/** Error whose message is an exact §4/§10 string the badge must show as-is. */
export class PipelineError extends Error {}

export interface PipelineDeps {
  /** One det pass over a slice; polygons in the slice's own coordinates. */
  detect(slice: ImageData): Promise<Polygon[]>;
  /** One rec batch — at most REC_MAX_BATCH (16) crops, same order back. */
  recognizeBatch(crops: ImageData[], lang: SrcLang, lite: boolean): Promise<RecResult[]>;
  /** LaMa worker path (patch-wise, never the full page — §7.7). */
  inpaintLama(crop: ImageData, mask: Uint8Array): Promise<ImageData>;
  /** §7.6 backend (created by the caller from the effective settings). */
  backend: TranslateBackend;
}

export interface PipelineCallbacks {
  onProgress(event: ProgressEvent): void;
  /** Streaming composite after each painted balloon (RGBA, natural size). */
  onComposite(rgba: ArrayBuffer, width: number, height: number): void;
}

export interface RunPipelineArgs {
  imageId: string;
  /** Natural-size RGBA of the fetched image (background fetch, §6.2). */
  image: ImageData;
  /** Effective settings — the caller applies the per-site srcLang (A6). */
  settings: Settings;
  font: FontFace;
  deps: PipelineDeps;
  callbacks: PipelineCallbacks;
  signal: AbortSignal;
}

export interface PipelineResult {
  timings: Timings;
  translated: number;
  untranslated: number;
}

// Source of the "CONTEXT (previous page)" block (§7.6): the last 12 committed
// translations. Kept in the background context across jobs so consecutive
// pages chain; within one page, later chunks see the earlier chunks' commits.
const previousCommitted: string[] = [];

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

export async function runPipeline(args: RunPipelineArgs): Promise<PipelineResult> {
  const { imageId, image, settings, font, deps, callbacks, signal } = args;
  if (image.width <= 0 || image.height <= 0) throw new Error('empty image');
  const throwIfAborted = (): void => {
    if (signal.aborted) throw abortError();
  };
  const timings: Timings = { sliceMs: 0, detMs: 0, recMs: 0, clusterMs: 0, inpaintMs: 0, typesetMs: 0 };
  const emit = (stage: ProgressEvent['stage'], done: number, total: number, ms?: number): void => {
    callbacks.onProgress({
      imageId,
      stage,
      done,
      total,
      detail: ms === undefined ? undefined : `${Math.max(1, Math.round(ms))} ms`,
    });
  };

  // --- 1. slice (§6.3.1) ---
  let stageStart = performance.now();
  const slices = planSlicesForImage(image);
  timings.sliceMs = performance.now() - stageStart;
  emit('slice', 1, 1, timings.sliceMs);

  // --- 2. det (§6.3.2), one worker pass per slice ---
  const polys: Polygon[] = [];
  stageStart = performance.now();
  emit('det', 0, slices.length);
  for (let i = 0; i < slices.length; i++) {
    throwIfAborted();
    const sliceImg = cropRect(image, 0, slices[i].y0, image.width, slices[i].y1 - slices[i].y0);
    for (const p of await deps.detect(sliceImg)) polys.push(offsetPoly(p, 0, slices[i].y0));
    emit('det', i + 1, slices.length, performance.now() - stageStart);
  }
  timings.detMs = performance.now() - stageStart;
  // A force-cut at the slice cap can double-detect a straddling box; drop
  // exact integer-bbox duplicates (first wins).
  dedupePolys(polys);
  if (polys.length === 0) throw new PipelineError('No text found');

  // --- 3. rec (§6.3.3) in ≤ REC_MAX_BATCH worker batches ---
  const crops = polys.map((p) => cropPolygon(image, p.pts));
  const results: RecResult[] = [];
  stageStart = performance.now();
  for (let start = 0; start < crops.length; start += REC_MAX_BATCH) {
    throwIfAborted();
    const batch = crops.slice(start, start + REC_MAX_BATCH);
    results.push(...(await deps.recognizeBatch(batch, settings.srcLang, settings.lite)));
    emit('rec', Math.min(start + REC_MAX_BATCH, crops.length), crops.length, performance.now() - stageStart);
  }
  timings.recMs = performance.now() - stageStart;

  // SFX gate: crops scoring below settings.sfxThreshold are left untouched
  // (their pixels are never masked or inpainted and their text is not sent).
  const lines: Line[] = [];
  for (let i = 0; i < polys.length; i++) {
    const rec = results[i];
    if (!rec || rec.score < settings.sfxThreshold) continue;
    const text = rec.text.trim();
    if (text.length === 0) continue; // unrecognized noise — nothing to translate
    const [x0, y0, x1, y1] = polyBbox(polys[i].pts);
    lines.push({
      poly: polys[i],
      text,
      score: rec.score,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
    });
  }
  if (lines.length === 0) throw new PipelineError('No text found');

  // --- 4. cluster (§6.3.4); §7.5 direction rule ---
  stageStart = performance.now();
  const direction: 'rtl' | 'ltr' = settings.srcLang === 'ja' ? 'rtl' : 'ltr';
  const balloons = clusterBalloons(lines, direction);
  timings.clusterMs = performance.now() - stageStart;
  emit('cluster', 1, 1, timings.clusterMs);

  // --- 5. translate (§6.3.5) with streaming 6/7. inpaint + typeset ---
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.putImageData(image, 0, 0);

  const total = balloons.length;
  const translatedTags = new Set<number>();
  const committedThisJob: string[] = [];
  let llmFirstMs: number | undefined;
  let llmTotalMs = 0;
  let painted = 0;
  // Holder object: the paint closure assigns this asynchronously, so a plain
  // `let` would be narrowed to `null` at the post-await check.
  const paintState: { error: { err: unknown } | null } = { error: null };

  // Serial paint queue: balloons share one composite canvas, so inpaint +
  // typeset run in commit order; each entry is *scheduled* the moment its
  // translation commits (§6.3 streaming rule).
  let paintChain: Promise<void> = Promise.resolve();
  const pushPaint = (balloon: Balloon, text: string): void => {
    paintChain = paintChain
      .then(() => paintBalloon(balloon, text))
      .catch((err: unknown) => {
        paintState.error ??= { err };
      });
  };

  const paintBalloon = async (balloon: Balloon, text: string): Promise<void> => {
    throwIfAborted();
    const [bx0, by0, bx1, by1] = balloon.bbox;
    const cx0 = Math.max(0, Math.floor(bx0 - INPAINT_CROP_MARGIN));
    const cy0 = Math.max(0, Math.floor(by0 - INPAINT_CROP_MARGIN));
    const cx1 = Math.min(image.width, Math.ceil(bx1 + INPAINT_CROP_MARGIN));
    const cy1 = Math.min(image.height, Math.ceil(by1 + INPAINT_CROP_MARGIN));
    const cw = Math.max(1, cx1 - cx0);
    const ch = Math.max(1, cy1 - cy0);
    // Crop from the current composite: earlier balloons' painted pixels inside
    // this crop must survive the putImageData below.
    const crop = ctx.getImageData(cx0, cy0, cw, ch);
    const localPolys = balloon.lines.map((l) => offsetPoly(l.poly, -cx0, -cy0));
    const mask = buildMask(localPolys, cw, ch);
    const inpaintStart = performance.now();
    const patched =
      settings.inpaint === 'lama' ? await deps.inpaintLama(crop, mask) : inpaintTelea(crop, mask);
    timings.inpaintMs += performance.now() - inpaintStart;
    throwIfAborted();
    ctx.putImageData(patched, cx0, cy0);
    painted += 1;
    emit('inpaint', painted, total, timings.inpaintMs);

    const typesetStart = performance.now();
    typeset(ctx, balloon, [text], font);
    timings.typesetMs += performance.now() - typesetStart;
    emit('typeset', painted, total, timings.typesetMs);

    const out = ctx.getImageData(0, 0, image.width, image.height);
    callbacks.onComposite(out.data.buffer as ArrayBuffer, image.width, image.height);
  };

  // One balloon string per tag (§4: "Tag — 1-based index of a balloon string").
  const joined = balloons.map((b) => b.lines.map((l) => l.text).join(settings.srcLang === 'ko' ? ' ' : ''));
  const translateStart = performance.now();
  for (let offset = 0; offset < total; offset += MAX_TAGS_PER_REQUEST) {
    throwIfAborted();
    const count = Math.min(MAX_TAGS_PER_REQUEST, total - offset);
    const stats = await deps.backend.translate(
      {
        strings: joined.slice(offset, offset + count),
        glossary: settings.glossary,
        previous: previousCommitted.slice(-12),
      },
      (tag: number, text: string) => {
        const bi = offset + tag - 1;
        if (bi < 0 || bi >= total || translatedTags.has(bi)) return;
        translatedTags.add(bi);
        committedThisJob.push(text);
        pushPaint(balloons[bi], text);
        emit('translate', translatedTags.size, total, performance.now() - translateStart);
      },
    );
    llmTotalMs += stats.totalMs;
    llmFirstMs ??= stats.firstMs;
    previousCommitted.push(...committedThisJob.splice(0));
    if (previousCommitted.length > 12) previousCommitted.splice(0, previousCommitted.length - 12);
  }

  await paintChain;
  throwIfAborted();
  if (paintState.error) {
    const err = paintState.error.err;
    throw err instanceof Error ? err : new Error(String(err));
  }

  const untranslated = total - translatedTags.size;
  callbacks.onProgress({
    imageId,
    stage: 'done',
    done: 1,
    total: 1,
    // §6.5: the badge shows 'Untranslated: N line(s)' when tags are still
    // missing after the retry; a clean run just shows 'done' (§6.1).
    detail: untranslated > 0 ? `Untranslated: ${untranslated} line(s)` : undefined,
  });

  timings.llmFirstMs = llmFirstMs;
  timings.llmTotalMs = llmTotalMs;
  return { timings, translated: translatedTags.size, untranslated };
}

// ---------------------------------------------------------------------------
// Geometry / image helpers
// ---------------------------------------------------------------------------

/** Builds the ÷4 luma plane and runs §7.2 planSlices; final rows clamp to the image. */
function planSlicesForImage(image: ImageData): Slice[] {
  const w = Math.max(1, Math.floor(image.width / 4));
  const h = Math.max(1, Math.floor(image.height / 4));
  const luma = new Uint8Array(w * h);
  const src = image.data;
  const iw = image.width;
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < 4; dy++) {
        const y = by * 4 + dy;
        if (y >= image.height) break;
        for (let dx = 0; dx < 4; dx++) {
          const x = bx * 4 + dx;
          if (x >= iw) break;
          const p = (y * iw + x) * 4;
          sum += 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
          n++;
        }
      }
      luma[by * w + bx] = n > 0 ? sum / n : 255;
    }
  }
  // planSlices reports natural rows for an exact ÷4 downscale; clamp the last
  // slice to the true height (s3 assumption: the caller clamps).
  return planSlices(luma, w, h)
    .map((s) => ({ y0: Math.min(s.y0, image.height), y1: Math.min(s.y1, image.height) }))
    .filter((s) => s.y1 > s.y0);
}

/** Axis-aligned sub-rectangle copy, clamped to the image. */
function cropRect(image: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const cx = Math.max(0, Math.floor(x));
  const cy = Math.max(0, Math.floor(y));
  const cw = Math.max(1, Math.min(image.width - cx, Math.floor(w)));
  const ch = Math.max(1, Math.min(image.height - cy, Math.floor(h)));
  const out = new Uint8ClampedArray(cw * ch * 4);
  const src = image.data;
  const iw = image.width;
  for (let row = 0; row < ch; row++) {
    const s = ((cy + row) * iw + cx) * 4;
    out.set(src.subarray(s, s + cw * 4), row * cw * 4);
  }
  return toImageData(cw, ch, out);
}

/** Axis-aligned bbox crop of a polygon, clamped to the page (rec input). */
function cropPolygon(image: ImageData, pts: [number, number][]): ImageData {
  const [x0, y0, x1, y1] = polyBbox(pts);
  return cropRect(image, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function polyBbox(pts: [number, number][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function offsetPoly(poly: Polygon, dx: number, dy: number): Polygon {
  return { pts: poly.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]), score: poly.score };
}

/** Drops polygons whose integer bbox was already seen (force-cut straddlers). */
function dedupePolys(polys: Polygon[]): void {
  const seen = new Set<string>();
  const kept: Polygon[] = [];
  for (const p of polys) {
    const [x0, y0, x1, y1] = polyBbox(p.pts);
    const key = `${Math.round(x0)},${Math.round(y0)},${Math.round(x1)},${Math.round(y1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
  }
  polys.length = 0;
  polys.push(...kept);
}

function toImageData(w: number, h: number, data: Uint8ClampedArray): ImageData {
  // Same pattern as core/det.ts: native ImageData where the global exists
  // (browsers/workers), a structurally identical object otherwise.
  const g = globalThis as unknown as {
    ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData;
  };
  if (typeof g.ImageData === 'function') return new g.ImageData(data, w, h);
  return { width: w, height: h, data } as unknown as ImageData;
}
