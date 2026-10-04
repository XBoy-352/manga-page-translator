// OCR worker (docs/SPEC.md §7.0, §7.3, §7.4): DB detection and CTC
// recognition run here so the renderer thread stays free. Model bytes come
// from the OPFS cache only (lib/ort getSession → lib/modelCache readModel) —
// nothing in this worker touches the network.
//
// Requests are processed strictly in arrival order (promise chain), so each
// reply corresponds 1:1 to the request before it — no correlation ids.
//
//   → { kind: 'detect', buf, width, height, modelId }
//   ← { kind: 'polys', polys }     polygons in natural-image coordinates
//   → { kind: 'recognize', crops: [{ buf, w, h }], lang, lite? }
//   ← { kind: 'text', results }    one RecResult per crop, same order
//   ← { kind: 'error', message }   any failure

import { detectWith, type OrtRunner, type Polygon } from '../core/det';
import { buildCharset, recognizeCrops, type RecResult } from '../core/rec';
import { readModel } from '../lib/modelCache';
import { getSession, runSession, type OrtSession } from '../lib/ort';
import type { SrcLang } from '../shared/types';

export type OcrWorkerIn =
  | {
      kind: 'detect';
      buf: ArrayBuffer; // RGBA pixels, width × height × 4 bytes
      width: number;
      height: number;
      modelId: string; // registry id: 'det-small' | 'det-tiny'
    }
  | {
      kind: 'recognize';
      crops: { buf: ArrayBuffer; w: number; h: number }[]; // RGBA crop bitmaps
      lang: SrcLang;
      lite?: boolean; // zh lite → rec-zh-tiny + dict-zh-tiny (§7.4)
    };

export type OcrWorkerOut =
  | { kind: 'polys'; polys: Polygon[] }
  | { kind: 'text'; results: RecResult[] }
  | { kind: 'error'; message: string };

// Language → recognizer + dict (§7.4 / MODEL_REGISTRY §7.9).
const REC_FOR_LANG: Record<SrcLang, { rec: string; dict: string }> = {
  ja: { rec: 'rec-ja', dict: 'dict-ja' },
  ko: { rec: 'rec-ko', dict: 'dict-ko' },
  zh: { rec: 'rec-zh-small', dict: 'dict-zh-small' },
};

const charsets = new Map<string, string[]>();

async function charsetFor(dictId: string): Promise<string[]> {
  let charset = charsets.get(dictId);
  if (!charset) {
    const txt = new TextDecoder().decode(await readModel(dictId));
    charset = buildCharset(txt);
    charsets.set(dictId, charset);
  }
  return charset;
}

function toImageData(buf: ArrayBuffer, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(buf), width, height);
}

function runnerFor(session: OrtSession): OrtRunner {
  return (input) => runSession(session, input);
}

async function handleRequest(req: OcrWorkerIn, post: (msg: OcrWorkerOut) => void): Promise<void> {
  if (req.kind === 'detect') {
    const session = await getSession(req.modelId);
    const rgba = toImageData(req.buf, req.width, req.height);
    const polys = await detectWith(runnerFor(session), rgba);
    post({ kind: 'polys', polys });
    return;
  }
  if (req.kind === 'recognize') {
    // Lite mode swaps the zh recognizer to tiny (§7.4); ja/ko have no tiny rec.
    const ids =
      req.lite === true && req.lang === 'zh'
        ? { rec: 'rec-zh-tiny', dict: 'dict-zh-tiny' }
        : REC_FOR_LANG[req.lang];
    const [session, charset] = await Promise.all([getSession(ids.rec), charsetFor(ids.dict)]);
    const crops = req.crops.map((c) => toImageData(c.buf, c.w, c.h));
    const results = await recognizeCrops(runnerFor(session), crops, charset);
    post({ kind: 'text', results });
    return;
  }
  post({ kind: 'error', message: 'unknown OCR request' });
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<OcrWorkerIn>) => void) | null;
  postMessage(message: OcrWorkerOut): void;
}

const scope = self as unknown as WorkerScope;

let chain: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent<OcrWorkerIn>) => {
  const req = event.data;
  chain = chain
    .then(async () => {
      await handleRequest(req, (msg) => scope.postMessage(msg));
    })
    .catch((e: unknown) => {
      scope.postMessage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
};
