# Manga Page Translator — browser extension (Firefox + Chromium)

**Status:** agreed 2026-10-04
**Slug:** manga-page-translator
**Source conversation:** this session (user brief 2026-10-04 + Q&A)
**Primary repo:** /home/aditya/work/manga (new git repo, new GitHub repo `XBoy-352/manga-page-translator`)
**Base branch:** main

## 1. Goal

A Manifest-V3-compatible WebExtension that replaces the text inside speech
bubbles on an image already open in the current page. The user right-clicks an
image (or uses the toolbar action on the largest visible image) and gets the
same image back with original glyphs removed and the English translation
typeset into the bubbles. One click restores the original. OCR runs locally in
the browser (PP-OCR ONNX models), inpainting runs locally, and translation runs
through a pluggable backend: local Qwen3.5-0.8B (Transformers.js),
a user-configured OpenAI-compatible endpoint, or Chrome Nano when the browser
exposes it. The same codebase runs in Firefox and Chromium; WebGPU is used when
present and never required. No account, no analytics, no image ever leaves the
machine except translated *text* going to a backend the user configured.

## 2. Non-goals

- No site scraping, site adapters, or page-wide batch translation.
- No accounts, no analytics, no telemetry, no crash reporting.
- No cloud vision APIs; every pixel is processed on-device.
- No translation model beyond the pinned 0.8B-class `LOCAL_LLM`; no manga-ocr.
- No rehosting of model weights in the repo or any CDN we control.
- No store publishing (AMO / Chrome Web Store) in this PR — README covers
  temporary/load-unpacked installs only.
- No automatic source-language detection.
- No PDF/EPUB/video support; `<img>` elements only.
- No editing of the glossary mid-translation (applies on next page).

## 3. Acceptance criteria

- **AC1** `npm run build` emits `.output/chrome-mv3/` and
  `.output/firefox-mv3/` from one source tree; `web-ext lint` on the Firefox
  build reports 0 errors; both builds load per README steps.
- **AC2** On a page with a manga image: right-click → "Translate image" runs
  the full pipeline and swaps the `img` to the typeset image; invoking
  "Restore original image" (or the overlay toggle) brings back the original
  pixels exactly.
- **AC3** With models warm and WebGPU available, the non-LLM stages
  (slice → detect → recognize → cluster → inpaint → typeset) sum to ≤ 300 ms on
  the reference desktop (GTX 1660 Ti); the extension logs per-stage timings
  (`timings` field) that prove the number. On WASM/CPU the budget is
  best-effort; progress UI is shown and no hard failure occurs.
- **AC4** Unit tests pass: `npm test` covers slicing, DB postprocess, CTC
  decode, MST clustering + reading order, Telea invariants, tag parsing,
  prompt building, glossary injection.
- **AC5** Remote backend end-to-end: against `llama-server` (README command)
  a fixture page of ≥ 8 balloons translates; the first typeset balloon appears
  ≤ 2 s after the request starts (streaming per-line commit), and the full page
  completes when decoding ends. Measured numbers go in the PR body.
- **AC6** `grep -riE "analytics|telemetry|posthog|sentry|amplitude"` over `src/`
  finds nothing; the only network egress is (a) model downloads from the URLs
  in §Model registry and (b) chat completions to the user-configured
  `remoteUrl`, text-only payloads. A review note asserts no image bytes are
  ever sent to `remoteUrl`.
- **AC7** First use of a model that is not cached shows an explicit download
  consent dialog listing every file and its exact size (from the registry in
  §7.9) before any fetch; cancelling leaves OPFS untouched.
- **AC8** Firefox with WebGPU disabled completes a translation using the WASM
  execution provider (no time assertion).
- **AC9** The `nano` backend appears in settings only when
  `"LanguageModel" in self` and `(await LanguageModel.availability()) ===
  "available"`; otherwise it is absent (not merely disabled).

## 4. Glossary

| Term | Meaning | Exact spelling / value |
| --- | --- | --- |
| Slice | Horizontal sub-image cut from a tall strip at an empty row band | `slice` |
| Slice band | Run of consecutive near-uniform rows where a cut is allowed | `band` |
| Polygon | Detected text region, 4+ points, natural-image coordinates | `Polygon` |
| Crop | Axis-aligned bitmap extracted from a polygon for recognition | `crop` |
| Cluster / balloon | Set of line polygons joined by the MST into one speech balloon | `Balloon` |
| Tag | 1-based index of a balloon string inside one page's translate request | `tag` |
| SFX | Low-confidence stylized text that is left untouched | `sfx` |
| Lite mode | Setting `lite: true` → tiny detector (and tiny recognizer for zh) | `lite` |
| Backend | Translation source: `local` \| `remote` \| `nano` | `backend` |
| Mask | Uint8 image-sized alpha map of pixels to inpaint | `mask` |
| Overlay badge | Small floating pill top-right of a translated image | `overlay badge` |
| Context menu labels | UI strings | `Translate image`, `Restore original image` |
| Status strings | UI strings | `Downloading models…`, `No text found`, `Backend unreachable`, `Translation failed — retry?`, `Untranslated: N line(s)` |
| Models dir | OPFS root folder for cached model files | `/models/` |
| Model registry | Hard-coded list of downloadable model files + sizes | `MODEL_REGISTRY` |
| Stage timings | `{ sliceMs, detMs, recMs, clusterMs, inpaintMs, typesetMs, llmFirstMs, llmTotalMs }` | `timings` |

## 5. Current behaviour

N/A — the repository is empty (new project). There is no existing behaviour to
preserve; `main` starts empty and every file below is created by this PR.

## 6. Desired behaviour

### 6.1 Triggering a translation

- Content script context menu on any `<img>`: items `Translate image` and
  `Restore original image` (the restore item is only enabled when that image is
  currently translated). Both appear in the `image` context only.
- Toolbar action click: targets the largest `<img>` by visible area in the
  viewport; if none, the action badge shows `!` for 2 s (tooltip `No image found`).
- Pipeline is per-image and idempotent: a second trigger on the same image
  while running is a no-op; triggering on an already-translated image is a
  no-op until restored.
- Success/failure surfaces through the overlay badge: progress
  (`stage n/m`, e.g. `OCR 3/5 · 84 ms`), then `done` (badge fades after 2 s),
  or the exact error string from §4.

### 6.2 Image replacement

- Content script stores the original `src` + `srcset` + `sizes` attributes,
  removes `srcset`/`sizes`, fetches the image bytes **in the background
  context** (host permissions bypass CORS), runs the pipeline, transfers the
  result `ImageData`/ArrayBuffer to the content script, which creates a
  same-origin `blob:` URL and assigns it to `img.src`.
- Restore puts back the saved attributes verbatim.
- If the image element is removed from the DOM mid-run, the pipeline aborts
  silently (no badge, no error).
- If the page navigates, all pending jobs are aborted.

### 6.3 Pipeline stages (order is binding)

1. **Slice** — split tall strips on empty rows so no bubble is cut (§7.2).
2. **Detect** — PP-OCR DB detector → polygons (§7.3).
3. **Recognize** — per-crop CTC recognition (§7.4), with confidence-max over
   {0°, 90°, 270°} for tall crops (aspect h/w ≥ 1.6).
4. **Cluster** — MST over line-polygon centers → balloons; reading order by
   source language (§7.5).
5. **Translate** — one batched request per page of balloon strings (§7.6),
   streamed; each completed line is committed immediately.
6. **Inpaint** — Telea (default) or LaMa (quality toggle) inside the expanded
   text mask (§7.7). Never on the full page for LaMa.
7. **Typeset** — draw translated strings into the mask area (§7.8).

Inpainting of a balloon starts as soon as its translation commits (streaming),
not after the whole page decodes.

### 6.4 Translation request/response (normative example)

Request body to `POST {remoteUrl}/chat/completions`:

```json
{
  "model": "qwen3.5-0.8b",
  "temperature": 0,
  "stream": true,
  "max_tokens": 512,
  "chat_template_kwargs": { "enable_thinking": false },
  "messages": [
    { "role": "system", "content": "You translate comic dialogue to English. Keep each line short and natural. Preserve names exactly as written in the GLOSSARY. Keep the speaker's tone (casual, formal, shouting). Do not explain, annotate, or add quotes. Reply with exactly one line per input tag, in the same order, formatted 'N: translation'." },
    { "role": "user", "content": "GLOSSARY\n先輩=Senpai\n殿下=Your Highness\nCONTEXT (previous page)\n1: We need to leave now.\nTRANSLATE\n1: 待て!\n2: 許さんぞ…" }
  ]
}
```

`local` backend feeds the identical system+user strings to Qwen3.5-0.8B chat
template (thinking disabled); `nano` uses `LanguageModel` with the same
strings. Response parsing: any `<arg_key>think&gt;…&lt;/think&gt;` span is discarded before line
matching; collect `N: text` lines; a tag with no line triggers one retry with an
extra user message `Reply again. You missed tag(s): 2, 5. One line per tag.`;
still-missing tags are left untranslated (bubble untouched) and the badge shows
`Untranslated: N line(s)`.

### 6.5 Failure, timeout, partial failure

| Situation | Behaviour |
| --- | --- |
| Backend unreachable / HTTP error | Badge `Backend unreachable`; settings popup shows the same string with the URL |
| No response within 30 s (remote) | Abort, badge `Backend unreachable` |
| Malformed/missing tags after 1 retry | Untranslated bubbles stay original; badge `Untranslated: N line(s)` |
| OCR finds nothing | Badge `No text found`; image untouched |
| Model file download fails (HTTP ≠ 200) | Consent dialog shows the HTTP status; nothing cached |
| OPFS quota exceeded | Badge `Downloading models…` stops with `Storage full`; options page shows the same |
| Page with > 48 tags | Split into chunks of ≤ 48 tags, sequential requests, one stream each |
| Duplicate trigger on same image | No-op |

## 7. Interfaces (normative)

### 7.0 Runtime and stack

- TypeScript (strict), WXT (`wxt` ^0.20) + Vite, targets `chrome` and
  `firefox` from one codebase. Node ≥ 20.
- `onnxruntime-web` for det/rec/LaMa inside dedicated workers created from the
  background context. `@huggingface/transformers` ^3 for the local LLM.
- Tests: `vitest` (node environment, pure modules only).
- Execution providers always `['webgpu', 'wasm']` in that order — WebGPU is an
  accelerator, never a requirement. No Chrome-only APIs (`LanguageModel` is
  feature-detected, `chrome.offscreen` never used, no `chrome://` flags).

### 7.1 `shared/types.ts`

```ts
export type SrcLang = 'ja' | 'ko' | 'zh';
export type BackendKind = 'local' | 'remote' | 'nano';
export type InpaintMode = 'telea' | 'lama';

export interface Settings {
  srcLang: SrcLang;            // default 'ja'
  tgtLang: 'en';               // fixed in v1
  backend: BackendKind;        // default 'local'
  remoteUrl: string;           // default '' ; placeholder https://translator.mangal-coolify.duckdns.org/v1
  remoteApiKey: string;        // default '' ; sent as 'Authorization: Bearer <remoteApiKey>' when non-empty
  remoteModel: string;         // default 'qwen3.5-0.8b'
  inpaint: InpaintMode;        // default 'telea'
  lite: boolean;               // default false
  sfxThreshold: number;        // default 0.5
  glossary: { src: string; dst: string }[]; // default []
}

export interface Timings {
  sliceMs: number; detMs: number; recMs: number; clusterMs: number;
  inpaintMs: number; typesetMs: number; llmFirstMs?: number; llmTotalMs?: number;
}

export interface ProgressEvent {
  imageId: string;
  stage: 'download' | 'slice' | 'det' | 'rec' | 'cluster' | 'translate' | 'inpaint' | 'typeset' | 'done' | 'error';
  done: number; total: number;   // download: MB; translate: balloons; else steps
  detail?: string;
}

// messages (content ⇄ background)
export type BgRequest =
  | { kind: 'translate'; imageId: string; srcUrl: string; naturalWidth: number; naturalHeight: number }
  | { kind: 'restore'; imageId: string };
export type BgResponse =
  | { kind: 'progress'; event: ProgressEvent }
  | { kind: 'result'; imageId: string; ok: true; width: number; height: number; timings: Timings }
  | { kind: 'result'; imageId: string; ok: false; error: string }
  | { kind: 'imageBlob'; imageId: string; buf: ArrayBuffer; width: number; height: number };
```

### 7.2 `core/slice.ts`

```ts
export interface Slice { y0: number; y1: number }   // natural-pixel rows
export function planSlices(luma: Uint8Array, w: number, h: number, opts?: {
  maxSliceHeight?: number;   // default 1200
  minBand?: number;          // default 48
}): Slice[];
```

- Input `luma` is the luminance plane of a ÷4 downscale (1 byte/px, row-major).
- A row is **empty** when `p95(luma_row) − p5(luma_row) < 12`.
- Consecutive empty rows ≥ `minBand` form a band; cut at band centers.
- Greedy: walk top→down, cut at the first band center below
  `y0 + maxSliceHeight`; if no band exists before the cap, force-cut at the cap
  (documented risk, bubble straddling is then possible).

### 7.3 `core/det.ts` (PP-OCR DB detector)

```ts
export interface Polygon { pts: [number, number][]; score: number }
export function preprocessDet(rgba: ImageData, limitSideLen?: number): { x: Float32Array; w: number; h: number };
export function postprocessDb(prob: Float32Array, w: number, h: number, scale: number): Polygon[];
```

- Preprocess: BGR order, `/255`, mean `[0.485, 0.456, 0.406]`, std
  `[0.229, 0.224, 0.225]`; resize longest side to ≤ 960 keeping aspect, then pad
  H and W to multiples of 32.
- Postprocess constants (from `PP-OCRv6_small_det.yml`): `thresh = 0.2`,
  `box_thresh = 0.45`, `unclip_ratio = 1.4`, `max_candidates = 3000`,
  score_mode fast, no dilation. Algorithm: threshold prob map → connected
  components → for each component: area ≥ 16 and (short side ≥ 3 px at prob-map
  scale) → unclip via polygon offset by `area × unclip_ratio / perimeter`
  (Clipper-style offset, implement with a simple Minkowski disk expansion) →
  map back to natural coordinates by `1/scale` → min-area-rect 4-point polygon.
- Polygons with `score < 0.5` are dropped.

### 7.4 `core/rec.ts` (recognizer + CTC)

```ts
export interface RecResult { text: string; score: number }
export function preprocessRec(crop: ImageData): { x: Float32Array; w: number };
export function decodeCtc(logits: Float32Array, T: number, C: number, charset: string[]): RecResult;
export function buildCharset(dictTxt: string): string[]; // ["blank", ...dict lines, " "]
```

- Preprocess: RGB, `/255`, `(x − 0.5) / 0.5`; resize to height 48, width
  = round(48 × w/h) clamped to `[8, 320]`; batch crops into one tensor padded
  to the max width in the batch (≤ 16 crops per batch).
- Charset: `["blank"] + dict lines + [" "]`; **blank = index 0**.
- Decode: greedy argmax per step, collapse repeats, drop blanks; score = mean
  of chosen probs over non-blank steps.
- Tall crops (h/w ≥ 1.6): recognize at 0°, 90° and 270°; keep the rotation with
  the highest score. (Best-effort for vertical Japanese; see Assumption A1.)
- Language → recognizer + dict (from `MODEL_REGISTRY`, §7.9):
  `ja` → `japan_PP-OCRv3_mobile_rec_infer.onnx` + `japan_dict.txt`;
  `ko` → `korean_PP-OCRv5_mobile_rec_infer.onnx` + `ppocrv5_korean_dict.txt`;
  `zh` → `PP-OCRv6_small_rec.onnx` + `ppocrv6_dict.txt` (lite: `PP-OCRv6_tiny_rec.onnx`
  + `ppocrv6_tiny_dict.txt`).

### 7.5 `core/cluster.ts`

```ts
export interface Line { poly: Polygon; text: string; score: number; cx: number; cy: number; h: number }
export interface Balloon { lines: Line[]; order: number; bbox: [number, number, number, number] }
export function clusterBalloons(lines: Line[], direction: 'rtl' | 'ltr'): Balloon[];
```

- Build a minimum spanning tree (Kruskal) over line centers with Euclidean
  weights; drop MST edges longer than `T = 2.5 × median(line.h)`; remaining
  connected components are balloons. Singletons stay balloons.
- Order: group balloon centers into columns by x-gap > `0.5 × median(balloon
  width)`; `rtl` → columns right-to-left, lines inside a balloon right-to-left
  then top-to-bottom; `ltr` → columns left-to-right, lines top-to-bottom.
  `direction` is `'rtl'` for `srcLang === 'ja'`, `'ltr'` otherwise.

### 7.6 `core/translate/` (one interface, three backends)

```ts
export interface TranslateBackend {
  kind: BackendKind;
  translate(req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
            onLine: (tag: number, text: string) => void): Promise<{ totalMs: number; firstMs: number }>;
}
export function createBackend(s: Settings): TranslateBackend;  // throws BackendUnavailableError for nano when absent
```

- Prompt assembly (`prompt.ts`) is shared and unit-tested: glossary block
  (`GLOSSARY`, `src=dst` per line, ≤ 50 entries), previous-page block
  (`CONTEXT (previous page)`, last 12 committed strings, each truncated to
  60 chars, omitted on the first page), then `TRANSLATE` + `N: string` lines.
- System and user strings are exactly the normative example in §6.4.
- `remote`: `fetch(remoteUrl + '/chat/completions')`, `stream: true`, SSE
  parsing, `AbortController` with 30 s timeout; per-line commit via `onLine`;
  when `remoteApiKey` is non-empty, send header
  `Authorization: Bearer <remoteApiKey>`.
- `local`: Transformers.js `pipeline('text-generation', 'onnx-community/Qwen3.5-0.8B-Text-ONNX', { dtype: 'q4', device: navigator.gpu ? 'webgpu' : 'wasm' })`; applies the chat template with `enable_thinking: false`; token streaming through the same parser; runs in its own worker; default browser cache is used for weights (Assumption A4).
- `nano`: `new LanguageModel({ temperature: 0 })`; `promptStreaming()`; same parser. Guard exactly per AC9.

### 7.7 `core/inpaint/`

```ts
export function buildMask(polys: Polygon[], w: number, h: number, opts?: {
  strokePx?: number;   // default 4
  padPx?: number;      // default 24
}): Uint8Array;        // w*h, 255 = inpaint
export function inpaintTelea(rgba: ImageData, mask: Uint8Array, radius?: number): ImageData; // radius default 3
export async function inpaintLama(rgba: ImageData, mask: Uint8Array): Promise<ImageData>;    // patch-wise
```

- `buildMask`: rasterize each polygon (fill) + 4 px stroke on an
  OffscreenCanvas, then dilate the binary mask by `padPx` using a separable
  two-pass max filter.
- `inpaintTelea`: faithful TypeScript port of OpenCV's `INPAINT_TELEA`
  (fast-marching init + weighted 8-neighbourhood fill, radius 3). Invariants
  tested in §11: unmasked pixels bit-identical, no NaN, masked region is a
  plausible diffusion (L2 from a trivial mean-fill is lower).
- `inpaintLama`: for each dilated-mask connected bbox: pad context 64 px, snap
  patch W and H up to multiples of 64, run
  `lama-manga-dynamic.onnx` (dynamic input shapes), composite output only where
  `mask = 255`. Never runs on the full page.

### 7.8 `core/typeset.ts`

```ts
export function typeset(ctx: OffscreenCanvasRenderingContext2D, balloon: Balloon, translations: string[], font: FontFace): void;
```

- Font: `Comic Neue Bold` bundled as `assets/fonts/comic-neue-bold.woff2`
  (OFL; `@font-face` registered in the worker via `FontFace`).
- Fit: inset bbox by 4 px; greedy word-wrap into min(bboxW, 1.6 × bboxH);
  start font size = floor(0.9 × bboxH / estimated lines), shrink by 1 px steps
  to a floor of 9 px until wrapped height ≤ bboxH; if still overflowing at
  9 px, draw overflowing (never truncate text).
- Style: `fillStyle = '#ffffff'`, `strokeStyle = 'rgba(20,20,20,0.9)'`,
  `lineWidth = max(1.5, 0.08 × fontSize)`, `lineJoin = 'round'`, stroke then
  fill, centered horizontally and vertically per line.

### 7.9 Model registry (`lib/modelRegistry.ts`)

```ts
export const OCR_LFS_BASE = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
export const OCR_RAW_BASE = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main'; // .txt dicts are plain git blobs — media CDN 404s them
export interface ModelEntry { id: string; url: string; bytes: number; sha256?: undefined }
export const MODEL_REGISTRY: ModelEntry[] = [
  { id: 'det-small', url: `${OCR_LFS_BASE}/detection/PP-OCRv6_small_det.onnx`, bytes: 9_880_512 },
  { id: 'det-tiny',  url: `${OCR_LFS_BASE}/detection/PP-OCRv6_tiny_det.onnx`,  bytes: 1_780_590 },
  { id: 'rec-zh-small', url: `${OCR_LFS_BASE}/recognition/PP-OCRv6_small_rec.onnx`, bytes: 21_159_378 },
  { id: 'rec-zh-tiny',  url: `${OCR_LFS_BASE}/recognition/PP-OCRv6_tiny_rec.onnx`,  bytes: 4_462_639 },
  { id: 'dict-zh-small', url: `${OCR_RAW_BASE}/recognition/ppocrv6_dict.txt`, bytes: 74_948 },
  { id: 'dict-zh-tiny',  url: `${OCR_RAW_BASE}/recognition/ppocrv6_tiny_dict.txt`, bytes: 27_157 },
  { id: 'rec-ja',   url: `${OCR_LFS_BASE}/recognition/multi/japan/v3/japan_PP-OCRv3_mobile_rec_infer.onnx`, bytes: 10_031_937 },
  { id: 'dict-ja',  url: `${OCR_RAW_BASE}/recognition/multi/japan/v3/japan_dict.txt`, bytes: 17_333 },
  { id: 'rec-ko',   url: `${OCR_LFS_BASE}/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx`, bytes: 13_443_278 },
  { id: 'dict-ko',  url: `${OCR_RAW_BASE}/recognition/multi/korean/v5/ppocrv5_korean_dict.txt`, bytes: 47_452 },
  { id: 'lama', url: 'https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/main/lama-manga-dynamic.onnx', bytes: 206_291_843 },
];
export const LOCAL_LLM = { repo: 'onnx-community/Qwen3.5-0.8B-Text-ONNX', dtype: 'q4', bytes: 570_473_438 }; // q4 weights + tokenizer
```

- Sizes shown in the consent dialog come from these constants (AC7). The
  exact byte values above are the shipped numbers; workers must not invent
  others. Files are fetched at runtime and cached in OPFS under `/models/<id>`;
  the LLM is fetched by Transformers.js from its repo (never rehosted).

### 7.10 `lib/modelCache.ts`

```ts
export async function cachedIds(): Promise<Set<string>>;
export async function fetchToOpfs(entry: ModelEntry, onProgress: (mb: number, totalMb: number) => void): Promise<void>;
export async function readModel(id: string): Promise<ArrayBuffer>;
export async function clearModels(): Promise<void>;
```

- OPFS via `navigator.storage.getDirectory()`; partial downloads are staged in
  `/models/.tmp/<id>` and atomically moved on completion.

### 7.11 Manifest (WXT, generated)

- `manifest_version: 3`; `name: Manga Page Translator`;
  `permissions: ['storage', 'contextMenus']`;
  `host_permissions: ['<all_urls>']`; content script at `document_idle`,
  `all_frames: false`; background + popup + options per WXT entrypoints.
- Firefox build: WXT emits the background as a non-persistent event-page
  wrapper for the same source; no `browser_specific_settings` gecko id is
  required for temporary installs.

### 7.12 Serving the translation backend (README, normative)

Primary deployment — Coolify service on the Oracle A1 VM (aarch64, 4 cores /
24 GB), reverse-proxied by the existing Coolify Traefik:

- Image `ghcr.io/ggml-org/llama.cpp:server` (arm64 variant), attached domain
  `translator.mangal-coolify.duckdns.org` → container port `8081`; Traefik
  terminates TLS. The container binds `0.0.0.0` **inside the Docker network
  only** — no host port is published, so nothing is reachable except via
  Traefik.
- Persistent volume mounted at `/models` holding
  `Qwen/Qwen3.5-0.8B` (e.g. from `unsloth/Qwen3.5-0.8B-GGUF`; llama.cpp
  supports the Qwen3.5 Gated-DeltaNet operator since PR #19504).
- Service command:

```bash
--host 0.0.0.0 --port 8081 -c 4096 -np 2 \
  -m /models/Qwen3.5-0.8B-Q4_K_M.gguf \
  --api-key $LLAMA_API_KEY --no-webui
```

- The extension's `remoteUrl` is then
  `https://translator.mangal-coolify.duckdns.org/v1` with `remoteApiKey` set
  to `$LLAMA_API_KEY`.
- Private alternative (no public exposure): run the same binary on the VM host
  bound to the Tailscale/private address only, and put
  `http://<PRIVATE_IP>:8081/v1` in `remoteUrl` (port 8080 on the VM belongs to
  Traefik and is never used for llama-server).

## 8. Files

### May create

- `package.json`, `tsconfig.json`, `wxt.config.ts`, `vitest.config.ts`,
  `.gitignore`, `.github/workflows/ci.yml` — build, lint, test; CI runs
  `npm ci && npm run lint && npm test && npm run build` on both targets.
- `src/shared/types.ts`, `src/shared/settings.ts`, `src/shared/messages.ts` —
  §7.1 types, `DEFAULT_SETTINGS`, storage load/save with sync area.
- `src/core/slice.ts`, `src/core/det.ts`, `src/core/rec.ts`,
  `src/core/cluster.ts` — §7.2–7.5 pure logic (no DOM in these).
- `src/core/translate/prompt.ts`, `backend.ts`, `remote.ts`, `local.ts`,
  `nano.ts` — §7.6.
- `src/core/inpaint/telea.ts`, `src/core/inpaint/lama.ts`,
  `src/core/inpaint/mask.ts` — §7.7.
- `src/core/typeset.ts` — §7.8.
- `src/core/pipeline.ts` — stage orchestration, timings, streaming commits,
  per-image job map with cancellation.
- `src/lib/modelRegistry.ts`, `src/lib/modelCache.ts`, `src/lib/ort.ts` —
  §7.9–7.10; `ort.ts` owns session creation (`['webgpu','wasm']`), warmup
  (dummy 64×64 det inference on idle, cached models only), and worker spawn.
- `src/worker/ocr.worker.ts`, `src/worker/lama.worker.ts`,
  `src/worker/llm.worker.ts` — heavy work; renderer thread stays free.
- `src/entrypoints/background.ts`, `src/entrypoints/content.ts`,
  `src/entrypoints/popup/`, `src/entrypoints/options/` — shell: context menu,
  message router, image swap/restore/overlay, popup (src-lang quick selector +
  backend status), options (settings + glossary editor + Models download
  section with sizes/progress + Clear models).
- `src/assets/fonts/comic-neue-bold.woff2` + `OFL.txt` — typeset font.
- `tests/*.test.ts` — unit tests per §11; `tests/fixtures/` — small generated
  PNGs (a synthetic bubble page with known text is acceptable; do not commit
  copyrighted manga).
- `README.md` — Firefox temporary-install steps, Chromium load-unpacked steps,
  §7.12 llama-server command, limitations (vertical JP best-effort), privacy
  note (text-only to user-configured backend).
- `docs/ASSUMPTIONS.md` — maintained by workers per the standing rules.

### May modify

- Nothing pre-exists; after Slice 1 lands, later slices modify only the files
  they own (§12) — cross-slice edits require the orchestrator.

### Must not touch

- `docs/SPEC.md` — workers read it, never edit it.
- Model weights — never committed; `MODEL_REGISTRY` URLs are the only source.

## 9. Constraints

- Browsers: Firefox (latest stable, MV3) and Chromium (latest stable, MV3) are
  both required and both supported from one codebase. No Chrome-only APIs:
  no `LanguageModel` except the guarded nano path, no offscreen documents, no
  `chrome://` flags. WebGPU optional (`['webgpu','wasm']` always).
- Performance budgets (reference: GTX 1660 Ti desktop, models warm):
  non-LLM pipeline ≤ 300 ms (WebGPU; WASM best-effort with progress UI);
  end-to-end with LLM: first balloon ≤ 2 s via streaming commit; full page
  finishes when decode ends. Per-stage budgets: slice ≤ 5 ms, det ≤ 60 ms,
  rec ≤ 80 ms, cluster ≤ 5 ms, telea ≤ 30 ms, lama ≤ 400 ms, typeset ≤ 10 ms.
- Downloads: explicit first-run consent with sizes (AC7); cached in OPFS
  (`/models/`); LLM via Transformers.js default cache.
- Privacy: no account, no analytics, no image upload; remote payloads are
  chat messages (text) only.
- Dependencies allowed: `wxt`, `vite`, `typescript`, `vitest`,
  `onnxruntime-web`, `@huggingface/transformers`, `web-ext` (dev). No UI
  framework beyond the popup/options pages' plain DOM + a CSS file (no React).
  Do not add Clipper/polybool — polygon offset is implemented in-repo.
- Style: TypeScript strict, no `any` in exported signatures, ESLint defaults
  from WXT template.

## 10. Edge cases and errors

| Case | Expected behaviour | Exact error / UI / log |
| --- | --- | --- |
| No text detected | Badge, image untouched | `No text found` |
| Backend unreachable / HTTP error / 30 s timeout | Abort after retry rule (§6.5) | `Backend unreachable` |
| Missing tags after 1 retry | Leave those bubbles original | `Untranslated: N line(s)` |
| Model fetch 404/5xx | Consent dialog shows status; no cache write | `Download failed (HTTP 404)` |
| OPFS quota exceeded | Stop cleanly | `Storage full` |
| Image removed mid-run | Silent abort | (none) |
| Duplicate trigger | No-op | (none) |
| > 48 tags | Chunk into ≤ 48-tag requests, sequential | (progress continues) |
| Tall crop (h/w ≥ 1.6) | Try 0°/90°/270°, keep best score | (logged rotation chosen) |
| Model emits a `<arg_key>think&gt;…&lt;/think&gt;` block | Parser discards it before line matching | (none) |
| Very large image (> 8192 px side) | Downscale det input per §7.3; typeset on natural size | (none) |
| `nano` selected but unavailable | Settings hide the option; if storage says `nano`, fall back to `local` | (none) |
| Firefox without WebGPU | WASM provider, progress UI, no failure | (none) |
| Glossary entry missing '=' | Ignored in editor with inline hint | `Use src=dst` |
| Remote URL without scheme | Settings validation error | `URL must start with http:// or https://` |
| Remote returns 401/403 | Abort; point at settings | `Backend unreachable (check URL and API key)` |

## 11. Tests / verification

- Unit (CI): `npm test`
  - `slice.test.ts` — synthetic luma planes: band detection, force-cut at cap,
    bubble-width gap respected.
  - `det.test.ts` — synthetic prob map → expected polygon count/coords;
    unclip math on a known rectangle.
  - `rec.test.ts` — `decodeCtc` with hand-built logits (repeats, blanks,
    `["blank"]+dict+" "` charset); `buildCharset` on a fixture dict.
  - `cluster.test.ts` — MST clustering on fixture coordinates; rtl/ltr order.
  - `telea.test.ts` — invariants from §7.7.
  - `prompt.test.ts` — glossary/context/tag blocks byte-exact vs §6.4.
  - `parse.test.ts` — streaming line parser: complete lines, retry trigger,
    garbage tolerance.
- Integration (local, marked `integration`, skipped in CI):
  `npm run test:int` — downloads det-tiny + rec-tiny + dicts from
  `MODEL_REGISTRY`, runs detect+decode on `tests/fixtures/bubble.png`
  (synthetic page with known strings), asserts non-empty correct text.
- Manual verification (PR body checklist): AC1 build+lint output; AC2
  translate/restore on a public-domain manga sample page in both browsers;
  AC3/AC5 timings from the built-in `timings` log; AC7 cancel path;
  AC8 Firefox WASM run; AC9 nano visibility on Chromium.
- Regression set: the full unit suite must stay green after every slice.

## 12. Task slices (dispatch list)

### Slice `s1-scaffold`
- **Depends on:** none
- **Worker:** `tier: "small"`
- **Allowed files:** package.json, tsconfig.json, wxt.config.ts, vitest.config.ts, .gitignore, .github/workflows/ci.yml, README.md (skeleton only), src/entrypoints/* stubs, src/shared/* (types + DEFAULT_SETTINGS verbatim from §7.1)
- **Forbidden files:** everything else
- **Deliverable:** WXT project building both targets; CI green; settings round-trip through storage.
- **Verify:** `npm run build && npm test`
- **Done when:** AC1 build part passes; types compile strict.

### Slice `s2-models`
- **Depends on:** s1
- **Worker:** `tier: "small"`
- **Allowed files:** src/lib/modelRegistry.ts, src/lib/modelCache.ts, src/entrypoints/options/* (Models section only)
- **Forbidden files:** src/core/**, src/worker/**
- **Deliverable:** MODEL_REGISTRY verbatim (§7.9), OPFS cache with staged downloads + progress, consent dialog with sizes, Clear models.
- **Verify:** `npm test` + manual: download det-tiny (1.0 MB) → appears in cachedIds; cancel → nothing cached.
- **Done when:** AC7.

### Slice `s3-slice`
- **Depends on:** s1
- **Worker:** `tier: "small"`
- **Allowed files:** src/core/slice.ts, tests/slice.test.ts
- **Forbidden files:** everything else
- **Deliverable:** `planSlices` per §7.2 with tests.
- **Verify:** `npx vitest run tests/slice.test.ts`
- **Done when:** tests green.

### Slice `s4-ocr`
- **Depends on:** s2, s3
- **Worker:** `tier: "medium"`
- **Allowed files:** src/core/det.ts, src/core/rec.ts, src/lib/ort.ts, src/worker/ocr.worker.ts, tests/det.test.ts, tests/rec.test.ts, tests/fixtures/*, tests/int/ocr.int.test.ts
- **Forbidden files:** src/core/translate/**, src/entrypoints/**
- **Deliverable:** det pre/post (§7.3 constants), rec + CTC (§7.4), ort session helper with `['webgpu','wasm']` and idle warmup, worker wrapper, fixture integration test.
- **Verify:** `npx vitest run tests/det.test.ts tests/rec.test.ts` and locally `npm run test:int`
- **Done when:** unit tests green; integration test decodes the fixture text.

### Slice `s5-cluster`
- **Depends on:** s1
- **Worker:** `tier: "small"`
- **Allowed files:** src/core/cluster.ts, tests/cluster.test.ts
- **Forbidden files:** everything else
- **Deliverable:** MST clustering + reading order per §7.5.
- **Verify:** `npx vitest run tests/cluster.test.ts`
- **Done when:** tests green.

### Slice `s6-inpaint`
- **Depends on:** s1
- **Worker:** `tier: "medium"`
- **Allowed files:** src/core/inpaint/mask.ts, src/core/inpaint/telea.ts, src/core/inpaint/lama.ts, src/worker/lama.worker.ts, tests/telea.test.ts
- **Forbidden files:** src/core/det.ts, src/core/rec.ts
- **Deliverable:** buildMask, Telea port with §7.7 invariants, LaMa patch runner (64-px snapping, never full page).
- **Verify:** `npx vitest run tests/telea.test.ts`
- **Done when:** tests green.

### Slice `s7-typeset`
- **Depends on:** s1
- **Worker:** `tier: "small"`
- **Allowed files:** src/core/typeset.ts, src/assets/fonts/*, tests/typeset.test.ts
- **Forbidden files:** everything else
- **Deliverable:** §7.8 with the bundled Comic Neue Bold; test uses a stub font + measures fit/shrink logic.
- **Verify:** `npx vitest run tests/typeset.test.ts`
- **Done when:** tests green.

### Slice `s8-translate`
- **Depends on:** s1 (pure parts), s2 (local backend)
- **Worker:** `tier: "medium"`
- **Allowed files:** src/core/translate/prompt.ts, src/core/translate/backend.ts, src/core/translate/remote.ts, src/core/translate/local.ts, src/core/translate/nano.ts, src/worker/llm.worker.ts, tests/prompt.test.ts, tests/parse.test.ts
- **Forbidden files:** src/core/det.ts, src/entrypoints/**
- **Deliverable:** prompt builder byte-exact vs §6.4, streaming parser, three backends behind `createBackend`, nano guard per AC9.
- **Verify:** `npx vitest run tests/prompt.test.ts tests/parse.test.ts`
- **Done when:** tests green; AC9 guard demonstrable.

### Slice `s9-shell`
- **Depends on:** s3, s4, s5, s6, s7, s8
- **Worker:** `tier: "medium"`
- **Allowed files:** src/core/pipeline.ts, src/entrypoints/background.ts, src/entrypoints/content.ts, src/entrypoints/popup/*, src/shared/messages.ts (wire-up only)
- **Forbidden files:** src/core/inpaint/**, src/core/translate/**
- **Deliverable:** context menu + toolbar targeting, message router, background fetch of image bytes, worker orchestration with per-stage timings and cancellation, blob swap/restore, overlay badge with progress + exact strings from §4, per-site srcLang memory (Assumption A6).
- **Verify:** `npm run build && npm test` + manual AC2 run in Chromium.
- **Done when:** AC2, AC3 (timings logged), AC6 part (no extra egress).

### Slice `s10-readme`
- **Depends on:** s9
- **Worker:** `tier: "small"`
- **Allowed files:** README.md, docs/ASSUMPTIONS.md (consolidate)
- **Forbidden files:** src/**
- **Deliverable:** install steps (Firefox temporary, Chromium load-unpacked), §7.12 command, limitations, privacy note.
- **Verify:** follow the Firefox steps literally on a clean profile.
- **Done when:** AC1 fully (both loads), README complete.

### Review slices (after s9, parallel)
- **`r1-spec-compliance`:** reviewer reads docs/SPEC.md + diff; rejects any invented names/APIs/strings. Untagged worker.
- **`r2-code-review`:** adversarial review of pipeline correctness (mask math, worker lifecycle, memory of ImageData copies) and AC6 egress audit. Untagged worker.
- Fix slices dispatched from their findings before PR.

## 13. Assumptions (pre-agreed)

- **A1** Vertical Japanese (tategaki) is best-effort: tall crops are
  recognized at 0°/90°/270° and the best score wins; japan v3 is a horizontal
  model, so vertical accuracy is limited. Documented in README. Cost if wrong:
  some vertical lines mistranslated; swap-in recognizer can come later.
- **A2** Target language is fixed to English in v1 (`tgtLang: 'en'`); the
  field exists so later slices can expose it.
- **A3** `sfxThreshold` applies to recognition score only (`conf < 0.5` →
  untouched); cluster-less but confident text (captions) is translated.
- **A4** LLM weights are cached by Transformers.js' default browser cache;
  OCR/LaMa/dicts are cached in OPFS. (User asked "IndexedDB or OPFS"; OPFS
  covers all extension-managed files.)
- **A5** `remoteUrl` defaults to `''` (public extension must not ship a
  personal endpoint); the user configures e.g. `http://<PRIVATE_IP>:8081/v1`.
  Placeholder text in the settings field is `http://localhost:8081/v1`.
- **A6** Source language is remembered per hostname in `storage.local`
  (`perSiteSrcLang`), overriding the global default on that site.
- **A7** Default backend is `local` (Transformers.js) so a public install works
  with zero configuration; the OCI/tailscale server is documented, not default.
- **A8** Reading order: `ja` → right-to-left column-major; `ko`/`zh` →
  left-to-right row-major.
- **A9** The remote endpoint is served via Coolify + Traefik at
  `https://translator.mangal-coolify.duckdns.org/v1` (llama-server container,
  no host port published, `--api-key` supported via the extension's
  `remoteApiKey`); a tailscale-only bind is documented as the private
  alternative. Port 8080 on the VM belongs to Traefik.
- **A11** `remoteApiKey` is optional (default `''`); when set it is sent as
  `Authorization: Bearer <remoteApiKey>`; HTTP 401/403 from the remote shows
  `Backend unreachable (check URL and API key)`.
- **A12** Translation model = **Qwen3.5-0.8B** (2026 generation, 201
  languages, hybrid Gated-DeltaNet architecture) — local via
  `onnx-community/Qwen3.5-0.8B-Text-ONNX` q4 (~570 MB download), remote via
  `unsloth/Qwen3.5-0.8B-GGUF` Q4_K_M on the VM. Thinking mode is disabled
  (`enable_thinking: false`) and `<arg_key>think&gt;` blocks are stripped by the parser.
  Replaces Qwen2.5-1.5B per user request 2026-10-04.
- **A10** Repo name `manga-page-translator`, public, under the user's GitHub
  account; base branch `main`.

## 14. Open questions

None — all resolved in discussion (2026-10-04). Latency targets finalized as
300 ms non-LLM / first-balloon ≤ 2 s with LLM (§9, AC3, AC5).

## 15. Out of this PR

- Store publishing and signing; auto language detection; manga-ocr or any
  alternate recognizer; multi-image/batch translation; text extraction or
  subtitle files; an options-page model-manager for third-party models;
  localization of UI strings beyond English.
