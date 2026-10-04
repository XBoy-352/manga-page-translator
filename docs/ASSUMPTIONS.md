# Assumptions

Decisions taken where docs/SPEC.md is silent, per slice. SPEC.md stays binding; these rows never override it.

## Spec §13 pre-agreed assumptions — consolidated index (2026-10-04)

Where each pre-agreed assumption is realized in the shipped code / README. Slice sections below carry the details.

- **A1 — Vertical Japanese (tategaki) best-effort:** implemented in `src/core/rec.ts` (0°/90°/270° recognition for h/w ≥ 1.6 crops, best score wins; s4); documented in README → Limitations.
- **A2 — `tgtLang` fixed to `'en'`:** `shared/types.ts` / `DEFAULT_SETTINGS.tgtLang` (s1).
- **A3 — `sfxThreshold` applies to recognition score only; captions translated:** s9 SFX gate — crops scoring below the threshold are dropped before clustering (never masked, inpainted or translated); cluster-less confident text is translated. Documented in README → Limitations.
- **A4 — LLM weights via Transformers.js' default browser cache; OCR/LaMa/dicts in OPFS:** `src/lib/modelCache.ts` (`/models/`, staged `.tmp/`), options-page LLM row without its own Download button (s2), README → First-run model downloads.
- **A5 — `remoteUrl` defaults to `''`, placeholder `http://localhost:8081/v1`:** `DEFAULT_SETTINGS.remoteUrl = ''` (s1). The placeholder text belongs to the settings field; the options-page settings editor is still a stub in this build, so no field renders it yet.
- **A6 — Per-site source language in `storage.local` (`perSiteSrcLang`):** s9 — popup quick selector writes it via the content script, background resolves `perSite[hostname] ?? settings.srcLang` at job start.
- **A7 — Default backend `local`:** `DEFAULT_SETTINGS.backend = 'local'` (s1); README documents the remote server as an option, not the default.
- **A8 — Reading order ja → right-to-left column-major, ko/zh → left-to-right row-major:** s5 `clusterBalloons` + the `direction` mapping from `srcLang`.
- **A9 — Coolify + Traefik deployment, Tailscale-only private alternative, port 8080 = Traefik:** README → llama-server section (normative SPEC §7.12, reproduced verbatim).
- **A10 — Repo `manga-page-translator`, public, base branch `main`:** unchanged.
- **A11 — Optional `remoteApiKey` as `Authorization: Bearer`, 401/403 → `Backend unreachable (check URL and API key)`:** s8 `remote.ts` (header) + s9 error mapping (string).
- **A12 — Qwen3.5-0.8B everywhere (local `onnx-community/Qwen3.5-0.8B-Text-ONNX` q4, remote `unsloth/Qwen3.5-0.8B-GGUF` Q4_K_M, thinking disabled):** normative per SPEC §6.4/§7.9; README documents the spec values. **Drift flag:** see the s10 entry below — the checked-out code still names Qwen2.5-1.5B in `src/lib/modelRegistry.ts`, `src/shared/settings.ts`, `src/core/translate/local.ts` and `src/worker/llm.worker.ts`.

## s10 — README + assumptions (2026-10-04)

- **README model sizes** reproduce the SPEC §7.9 `MODEL_REGISTRY` / `LOCAL_LLM` byte values verbatim (AC7: "the exact byte values above are the shipped numbers").
- **Cross-slice drift flag (not fixable in s10, src/** is out of scope):** the code at HEAD still carries the pre-swap identifiers — `LOCAL_LLM = onnx-community/Qwen2.5-1.5B-Instruct` (1,787,566,590 B) in `src/lib/modelRegistry.ts`, `DEFAULT_SETTINGS.remoteModel = 'qwen2.5-1.5b'` in `src/shared/settings.ts`, and Qwen2.5 references in `src/core/translate/local.ts` / `src/worker/llm.worker.ts`. These predate the 2026-10-04 spec swap to Qwen3.5-0.8B (commit b84a118) and contradict A12/§7.9; the s2/s8 owners (or the orchestrator) must reconcile. The README documents the binding spec values.
- **Firefox-only build command in README:** `npm run build -b firefox` fails — npm parses `-b` as its own flag (`EUNKNOWNCONFIG`, verified). README documents `npm run build` (both targets) and `npx wxt build -b firefox` (Firefox only).
- **README verification (clean profile):** `npx web-ext lint --source-dir .output/firefox-mv3` → 0 errors / 7 warnings; temporary install verified literally via `npx web-ext run --source-dir .output/firefox-mv3` on a fresh profile → "Installed … as a temporary add-on" (the about:debugging → This Firefox → Load Temporary Add-on path).

## s1 — scaffold WXT extension + shared types (2026-10-04)

- **lint / compile scripts:** `wxt prepare && tsc --noEmit`. Spec §9 mentions "ESLint defaults from WXT template", but slice s1 allows only the pinned dependency list (no ESLint packages), so the TypeScript strict compiler is the lint gate for now. Revisit if reviewers allow adding ESLint dev-dependencies.
- **Pinned versions:** `wxt 0.20.27` (latest of the required ^0.20 line), `vite 6.4.3`, `vitest 3.2.7`, `typescript 5.9.3`, `@huggingface/transformers 3.8.1` (latest ^3), `onnxruntime-web 1.22.0-dev.20250409-89f8206ba4` (the exact ORT build bundled by transformers 3.8.1, so the app and Transformers.js share one copy), `web-ext 10.7.0` (dev).
- **Settings storage key:** the whole `Settings` object is stored under the key `settings` in `browser.storage.sync`; SPEC §7.1 does not name the key.
- **`shared/messages.ts`:** re-exports `BgRequest` / `BgResponse` / `ProgressEvent` from `shared/types.ts`, where §7.1 defines them; the module exists as the content ⇄ background surface for s9.
- **`test:int` config:** `passWithNoTests: true` until slice s4 adds `tests/int/ocr.int.test.ts`, so the script exits green today while still targeting `tests/int/**`.
- **package-lock.json is committed:** CI (`npm ci`) requires it; generated by `npm install` from the pinned versions above.
- **build script:** runs `wxt build -b chrome` then `wxt build -b firefox` sequentially from the single source tree (AC1).
- **Firefox gecko id:** SPEC §7.11 states no `browser_specific_settings.gecko.id` is required, but AC1 requires `web-ext lint` 0 errors and web-ext (8.5.0 and 10.7.0 both tested) reports `ADDON_ID_REQUIRED` as an **error** for a Firefox MV3 manifest without an id. Resolved in favor of AC1: a Firefox-only gecko id `manga-page-translator@xboy-352.dev` is emitted (chrome manifest stays unchanged). Flag for reviewer/user: replace with a preferred add-on id if one exists.
- **WXT `srcDir: 'src'` and `manifestVersion: 3`:** WXT defaults to root `entrypoints/` and Firefox MV2; both are overridden to match the SPEC §8 `src/` layout and §7.11 MV3-for-both-targets requirement.

## s2 — model registry + OPFS cache + download UI (2026-10-04)

- **`fetchToOpfs` optional AbortSignal:** §7.10 fixes a two-parameter signature, but the s2 UI requirement "cancelling mid-download deletes the .tmp file and caches nothing" needs a cancel channel; an optional third parameter `signal?: AbortSignal` was added. Two-argument calls per §7.10 remain valid; on abort the tmp file is removed and the AbortError is rethrown so the UI can report "Cancelled — nothing cached".
- **Atomic publish:** `FileSystemFileHandle.move()` is Chromium-only, so moving `/models/.tmp/<id>` into `/models/<id>` copies the staged bytes through a final `createWritable()` whose `close()` is the atomic publish point (File System Access swap-file semantics), then removes the tmp file. Works on Firefox and Chromium. On publish failure the tmp file is removed and, if no copy was cached before, the possibly-created empty placeholder at `/models/<id>` is removed so a failed download caches nothing.
- **MB unit:** progress and sizes use MB = MiB (1,048,576 bytes), matching the registry's MiB-aligned byte values (9_437_184 = 9 MB, etc.).
- **`Storage full` mapping:** a `QuotaExceededError` DOMException raised by any OPFS write during download or publish is mapped to `Error('Storage full')` (§10); a non-200 fetch status (or missing response body) maps to `Error('Download failed (HTTP <code>)')`.
- **`readModel` error scope:** only `NotFoundError` from OPFS is translated to `Error('Model not cached: <id>')`; other storage errors propagate unchanged so real failures are not masked as "not cached".
- **LOCAL_LLM row has no Download button:** the LLM weights are fetched by Transformers.js from the §7.9 `LOCAL_LLM` repo (never rehosted) and cached in its default browser cache on first use of the local backend (A4). The options row shows repo + exact size and a note saying weights download on first local use; wiring a second download path here would duplicate slice s8's `local.ts`. (Repo/size as shipped at s2 time were Qwen2.5-1.5B-Instruct / 1,787,566,590 B; superseded by the A12 swap to `onnx-community/Qwen3.5-0.8B-Text-ONNX` / 570,473,438 B — the decision stands, the constants need the s2-owner update flagged under s10.)
- **Consent dialog scope:** the options page downloads one registry file per row, so the consent dialog lists that file's name + exact size in bytes (and human-readable form) before any fetch (AC7); the dialog is a native `<dialog>`, and Esc/close counts as cancel.

## s8 — translation backends + prompt + parser (2026-10-04)

- **`GlossaryEntry` location:** defined (and exported) in `src/core/translate/prompt.ts`; structurally identical to the `Settings.glossary` entry type in `shared/types.ts`, but `shared/types.ts` is outside this slice's allowed file list.
- **User-message separators:** the s8 formula ("GLOSSARY\n" + one "src=dst" line per entry + … + "\nTRANSLATE\n" + tag lines) is implemented as literal string concatenation with lines joined by single `\n`; block headers supply the terminating newline of the previous block. This reproduces the §6.4 normative example byte-exactly (no blank lines between blocks). Degenerate consequence, followed literally: with an empty glossary the two separators meet, leaving exactly one blank line after `GLOSSARY` (locked by a test).
- **CONTEXT block numbering:** previous-page lines are renumbered `1..12` over the last 12 committed strings (the example shows `1: …`); the 60-char cap applies to the raw string, before the `N: ` prefix.
- **Line parser home:** the shared streaming parser lives in `backend.ts` (`LineParser`) because no separate parser file is in the s8 allowed list; all three backends feed it (remote SSE deltas, local worker token callbacks, nano stream chunks).
- **Retry ownership:** `runTranslate` in `backend.ts` drives both passes — it builds the §6.4 messages, measures `firstMs`/`totalMs`, dedupes repeated tags (first commit wins), and issues the single §6.4 retry with `Reply again. You missed tag(s): …` appended as one extra user message. The retry re-sends `[system, user, retry-user]` without the partial assistant turn (spec does not specify one). nano reuses its session, so its retry naturally continues the same conversation.
- **nano guard split (AC9):** `createBackend` is a sync signature, so it throws `BackendUnavailableError('Chrome Nano unavailable')` synchronously when `"LanguageModel" in self` is false; the async `availability() !== 'available'` half throws the same error from `translate()`. `nanoAvailable()` is exported for the settings UI so the option can be hidden entirely when unavailable.
- **nano `promptStreaming` shape:** consumed as `ReadableStream<string>` (current Prompt API) with an async-iterable fallback for the earlier origin-trial shape.
- **Remote 30 s timeout:** implemented as a rearmed idle timeout — started before `fetch` and reset on every received chunk — so "no response within 30 s" (§6.5) aborts silent endpoints without killing healthy long streams (a 48-tag page can legitimately decode for minutes).
- **Remote error surface:** unreachable / HTTP error / timeout / mid-stream drop all throw `Error('Backend unavailable', { cause })` — the exact §4 string, with the underlying reason preserved on `cause` for the settings popup; the pipeline (s9) can pass it through to the badge.
- **Local worker lifecycle:** `local.ts` spawns `src/worker/llm.worker.ts` (Vite module-worker URL pattern) once per backend instance and keeps it alive so weights stay warm across pages; on any generation failure the worker is terminated and respawned on the next call. The worker protocol is `{type:'translate', messages}` in → `{type:'line'|'done'|'error'}` out; one message = one generation pass, so the retry reuses the warm worker.
- **Local generation options:** `max_new_tokens: 512` (spec) plus `do_sample: false` for greedy decoding, matching the remote backend's `temperature: 0` determinism; the model repo/dtype are fixed by §7.6, so no settings are read.
- **`pipeline` typing:** the `pipeline<'text-generation'>(…)` explicit type argument works around TypeScript TS2590 ("union type too complex") in transformers.js 3.8.1's overloads when `device`/`dtype` literals are passed.
- **`env` untouched:** transformers.js already defaults to `allowLocalModels: false` and browser-cache on in browser builds (A4), so no env overrides are set.

## s3 — webtoon slicing (2026-10-04)

- **Slice coordinates:** §7.2 annotates `Slice` as "natural-pixel rows" while `planSlices` receives the ÷4-downscaled luma plane, so the downscale factor is fixed at 4 (`DOWNSCALE = 4`) and cut positions are reported in natural pixels, assuming an exact ÷4 downscale (natural height = 4 × h). If the true natural height is not a multiple of 4, the pipeline caller clamps the final `y1`. Consequence: `maxSliceHeight` is in natural pixels (default 1200 → 300 downscaled rows per slice, matching the det stage's ≤ 960 longest-side resize), while `minBand` counts downscaled rows (the rows actually examined; default 48 → 192 natural px).
- **"First band center below y0 + maxSliceHeight":** read as the band center *nearest below the cap* (largest center in `(y0, y0 + maxSliceHeight)`), not the first band after `y0`. Packing each slice up to the cap keeps the slice count — and therefore det calls — minimal, consistent with the `maxSliceHeight` name and the AC3 det budget; the alternative reading would shard pages with dense gaps into many tiny slices.
- **Tail handling:** when the remaining strip already fits within the cap (`y0 + maxSliceHeight ≥ 4h`) it is emitted unsplit. Cuts exist only to enforce `maxSliceHeight`, so a strip never taller than the cap yields exactly one slice regardless of bands; otherwise every page with an internal band would be sharded even when within budget.
- **Percentile convention:** p5/p95 of a row are the smallest values whose cumulative 256-bin histogram count reaches `0.05 × w` / `0.95 × w` (nearest-rank; no sorting per §7.2). For `w = 0` a row counts as empty.
- **Degenerate opts:** non-positive `maxSliceHeight`/`minBand` are clamped to 1 so the greedy walk always makes progress and terminates (§7.2 is silent on invalid input).

## s5 — MST balloon clustering + reading order (2026-10-04)

- **Local `Polygon` type:** declared in `src/core/cluster.ts`, structurally identical to §7.3's `Polygon` (owned by `det.ts`, which s5 may not touch). The s5 dispatch explicitly allows the local declaration; structural typing keeps the two types mutually assignable.
- **Column grouping input:** "balloon centers" are balloon bbox centers (midpoint of `bbox[0..2]`, `bbox[1..3]`) and "balloon width" is `bbox[2] − bbox[0]`. Centers are swept in ascending x; a center-to-center x-gap > `0.5 × median(balloon width)` starts a new column.
- **Balloons within a column:** read top-to-bottom (ascending bbox-center y). SPEC §7.5 fixes only the column direction and the in-balloon line order; column-major reading (A8) implies top-to-bottom inside a column.
- **In-balloon line sort:** implemented as the literal two-key reading of §7.5 — `rtl`: cx descending, then cy ascending ("right-to-left then top-to-bottom"); `ltr`: cy ascending per spec, with cx ascending added as tie-break for deterministic output. No nested sub-column grouping inside a balloon, since SPEC gives no in-balloon threshold. Known limit: horizontally stacked lines in an `rtl` balloon with unequal cx are ordered by cx first, exactly as §7.5 text prescribes.
- **Edge filter strictness:** "drop MST edges longer than T" drops strictly-greater edges, so an edge with weight exactly `T` is kept.
- **Determinism:** equal-weight MST edges are considered in (i, j) index order; `clusterBalloons` returns balloons in reading order, so the array index always equals the balloon's `order` field.

## s6 — mask + Telea port + LaMa patches (2026-10-04)

- **Structural `Polygon`:** §7.3 defines `Polygon` in `core/det.ts` (slice s4);
  `core/inpaint/mask.ts` declares it locally (non-exported, `score` optional per
  the s6 slice contract, so bare `{ pts }` lists are accepted; §7.3's
  `score: number` stays assignable) — same local-declaration pattern as s5 in
  `core/cluster.ts`.
- **buildMask rasterization environments:** the production path rasterizes on
  an OffscreenCanvas per §7.7 (fill + `lineWidth = strokePx` stroke with round
  join/cap, binarized at ≥50% coverage, alpha ≥ 128). The node test environment
  has no OffscreenCanvas, so `mask.ts` falls back to a pure rasterizer
  (even-odd scanline fill at pixel centers + "pixel center within strokePx/2 of
  the boundary" stroke — exact for round joins/caps) producing the equivalent
  binary mask.
- **buildMask dilation:** implemented as the §7.7 separable two-pass max filter
  restricted to the content bbox (identical output; outside it the dilation is
  0). For binary input each 1-D pass is evaluated by run-expansion (identical
  to the sliding max); non-binary input falls back to the monotonic-deque
  sliding max.
- **Telea port source:** ported line-for-line from
  `opencv/modules/photo/src/inpaint.cpp` (4.x): expanded 1px grid, cross-dilate
  band, rect(2r+1) outer prepass with negated distances (icvCalcFMM negate
  path), Telea weights |r|⁻³ · 1/(1+|ΔT|) · |r·∇T| with the 0.01→1e-6 dir
  clamp, one-sided gradient fallbacks and the km/kp/lm/lp border fudges.
  Verified against `cv2.inpaint(..., cv2.INPAINT_TELEA)` (OpenCV 5.0.0) on
  random images with interior, edge-touching and corner masks at radius 3 and
  5: unmasked pixels bit-identical; masked pixels mean |diff| ≤ 0.21, max 5
  (f64 accumulation vs OpenCV f32, plus the rounding rule below).
- **Telea rounding:** OpenCV writes `saturate_cast<uchar>(sat + 0.5)` with
  cvRound = round-half-to-even; JS Math.round is half-up (would bias uniform
  fills by +1), so half-even is reproduced explicitly.
- **Telea channels:** OpenCV is 3-channel BGR; the weighted fill runs over all
  4 RGBA channels (alpha fills from surrounding alpha like any channel). ∇T is
  channel-independent, so it is computed once per filled pixel.
- **Telea performance:** measured (Node 26, this machine) ≈ 150 ms for a
  1200×1600 page whose dilated mask covers 114k px (5.9%), ≈ 36 ms buildMask.
  The scalar-JS port does not meet the §9 `telea ≤ 30 ms` per-stage budget on
  masks of this size; the offset-table fast path (precomputed distance weights
  and relative read offsets, strict-interior path without bounds checks) is
  already at practical scalar-JVM-JIT throughput. AC3's "WASM/CPU best-effort"
  clause applies; flagged for the orchestrator (options: smaller real-world
  text masks, or a future WebGPU Telea).
- **LaMa session runner injection:** third optional parameter per the s6 slice
  contract (`LamaSessionRunner`); without it `inpaintLama` throws — the worker
  always injects. Runner contract: RGB [0,1] CHW `Float32Array`, mask 1=hole,
  returns [1,3,H,W] floats assumed to be [0,1] and clamped to 0..255 on
  composite.
- **LaMa model I/O:** verified from the `lama-manga-dynamic.onnx` file itself:
  graph inputs `image` [b,3,h,w] and `mask` [b,1,h,w] (float32, dynamic h/w),
  output `inpainted` [b,3,h,w]; the graph computes `image·(1−mask)` then
  concatenates the mask, so mask 1 = hole and image in [0,1] RGB (byte order
  RGBA→RGB assumed). Output range [0,1] is an assumption (clamped).
- **LaMa patch geometry:** 64 px context clamped to the image, then W/H snapped
  UP to 64-multiples; if the snapped size overflows the right/bottom edge the
  patch origin shifts toward the image origin, and out-of-image tensor cells
  are edge-replicated. Each patch is fed the FULL dilated mask (all components)
  inside its window but composites only where `mask = 255`; overlapping patches
  process in component-label order and the last write wins. Components are
  4-connected. "Never the full page" holds per connected component; a single
  component spanning the whole page would yield a page-sized patch (no
  artificial cap — the spec defines no threshold).
- **lama.worker.ts protocol:** request `{ buf, width, height, maskBuf }` per
  the slice contract; the reply is the patched RGBA buffer posted as a
  transferred ArrayBuffer ("returns the patched buffer"). The worker creates
  the ORT session itself (slice task: "the worker wires onnxruntime") rather
  than via s4's `lib/ort.ts`, with executionProviders `['webgpu','wasm']` and a
  wasm-only retry per §7.0; the session is created once per worker.
- **onnxruntime-web typing:** its package.json exports map has no "types"
  condition, so Bundler resolution cannot reach the shipped `types.d.ts`
  (TS7016); the worker import carries a `@ts-ignore` with that explanation.
  `@ts-ignore` (not `@ts-expect-error`) so a future global module declaration
  from another slice cannot break this file.
- **ImageData in pure modules:** `inpaintTelea`/`inpaintLama` construct the
  result through the native `ImageData` constructor when the global exists
  (browsers/workers) and return a structurally identical plain object in the
  node test environment; `tests/telea.test.ts` installs a polyfill global.
  Signatures stay `ImageData` per §7.7.
- **s2 dependency:** `src/worker/lama.worker.ts` imports `readModel` from
  `src/lib/modelCache` per §7.10; s2 was not merged into this worktree's base
  at writing time, so `npm run lint` fails on that single import here.
  Verified on a throwaway tree at the s2 commit (b9e3b9e): `tsc --noEmit` clean
  and the full suite (27 tests) green with this slice's files added.

## s7 — typesetting engine + font (2026-10-04)

- **TTF instead of woff2 (approved):** `src/assets/fonts/comic-neue-bold.ttf` is the upstream Comic Neue Bold TTF from google/fonts/ofl/comicneue, committed as-is per the orchestrator's instruction (SPEC §7.8 names `comic-neue-bold.woff2`). `FontFace` accepts raw TTF bytes, so no conversion step is needed; the OFL license text is committed alongside as `OFL.txt`.
- **"Estimated lines" (§7.8):** read as `translations.length` (one initial line per provided string); the 1 px-step shrink loop corrects any underestimate by re-wrapping at each size.
- **bboxW/bboxH in the fit rules:** refer to the 4 px-inset box (the area the text must fit), not the raw balloon bbox; wrap width cap = min(insetW, 1.6 × insetH).
- **Line height:** `1.2 × fontSize` (SPEC §7.8 fixes neither leading nor how "wrapped height" is measured); wrapped height = line count × line height.
- **Overflow placement:** when text still overflows at the 9 px floor, the block is top-aligned at the inset top and spills downward only (centering an overflowing block would push text above the balloon); a fitting block is vertically centered.
- **registerFont side effects:** constructs `FontFace('Comic Neue Bold', bytes, { weight: 'bold' })`, awaits `load()` so the first draw never renders a fallback font, and adds the face to `globalThis.fonts` when the scope exposes a FontFaceSet (works for window and worker callers); returns the FontFace.
- **ctx.font built from the parameter:** `typeset` sets `ctx.font` from the passed FontFace's own `family`/`weight` (e.g. `bold 12px "Comic Neue Bold"`) rather than a hardcoded string, so the `font` argument is authoritative.
- **Start-size guard:** `floor(0.9 × bboxH / estimated lines)` is clamped to ≥ 1 px so a degenerate translation count cannot produce an invalid 0 px CSS font; the 9 px shrink floor is unaffected.
- **Centering via canvas alignment:** horizontal/vertical centering is done with `textAlign = 'center'` / `textBaseline = 'middle'` at the computed line centers, rather than by manually offsetting measured widths.

## s4 — PP-OCR detection + recognition on ort-web (2026-10-04)

- **`preprocessDet` return shape:** the s4 dispatch adds `scale` to §7.3's
  `{ x, w, h }` (postprocessDb needs it to map coordinates back); the object
  remains structurally assignable to the §7.3 shape. Returned `w`/`h` are the
  PADDED tensor dims (multiples of 32) — they are also the prob-map dims the
  caller passes back to `postprocessDb`.
- **Det preprocess details (§7.3 is silent on):** resize uses `Math.round` and
  is skipped entirely (`scale = 1`) when the longest side already fits
  `limitSideLen`; padding is bottom/right with raw black (0,0,0) BEFORE
  normalization, matching PaddleOCR's `DetResizeForTest` zero-pad order
  (NormalizeImage runs after resize/pad); resampling is bilinear
  (cv2.INTER_LINEAR equivalent) in `resizeRgbaBilinear` (det.ts, shared with
  rec.ts since no shared image-util file exists in the allowed set).
- **Pixel-center convention:** min-area rects span pixel-center coordinates
  like cv2 `findContours` + `minAreaRect` (a filled W-px-wide block yields
  side W−1). The `area ≥ 16` filter counts component pixels; the unclip
  distance uses the rect's geometric (shoelace) area, per PaddleOCR
  `get_expand_c`. Fast score mode samples integer pixel coordinates inside
  the pre-unclip min-area rect (boundary-inclusive), i.e. `box_score_fast`.
- **Score / threshold semantics:** one score per component — mean prob inside
  the pre-unclip min-area rect. `box_thresh = 0.45` gates candidates (§ dispatch);
  the same score rides on the returned polygon and §7.3's "score < 0.5 dropped"
  applies to it, making 0.5 the effective output threshold (the 0.45 gate is
  kept because both constants are binding). The score is not recomputed on the
  unclipped box (PaddleOCR carries the pre-unclip score through).
- **Minkowski disk expansion:** implemented exactly for convex quads by
  offsetting each edge line outward by `d` and intersecting adjacent lines
  (round joins only round corners, which the subsequent min-area rect
  ignores); outward normal sign is resolved against the polygon centroid, so
  it works for either vertex orientation.
- **Clipping:** final polygon points are clipped to `[0, w/scale] ×
  [0, h/scale]` (PaddleOCR clips to the destination size, but postprocessDb's
  §7.3 signature carries no natural dims; the padded extent is the tightest
  bound available here, and downstream crop/mask consumers clamp to the real
  image anyway).
- **Connected components:** 8-connected (cv2.findContours semantics),
  discovered in row-major scan order, candidates capped at the first 3000.
- **Extra exports in det.ts / rec.ts:** §7.3/§7.4 fix four functions each; the
  full-flow helpers were added in the same files so worker and integration
  test share one code path with the model call injected
  (`OrtTensorLike`/`OrtRunner`/`firstOutput`, `detProbMap`, `detectWith`;
  `buildRecBatch`, `rotateCrop`, `recognizeCrops`). No onnxruntime import in
  core/ — lib/ort.ts bridges to the real types (same pattern as s6's
  `LamaSessionRunner`).
- **decodeCtc values are probabilities:** the parameter is named `logits` per
  §7.4, but the values are treated as per-class probabilities (max value used
  as the chosen prob, no softmax applied). The PP-OCR rec inference models
  emit post-softmax CTC output (CTCHead applies softmax in eval mode);
  verified on rec-zh-tiny in the integration test (scores 0.988 / 0.966).
  Argmax — and therefore text — is identical either way; only the score scale
  would differ if a build emitted raw logits.
- **`buildCharset`:** strips a leading UTF-8 BOM and drops empty lines
  (trailing-newline artifacts); dict lines are kept verbatim otherwise.
- **Batch padding:** zero-padded after normalization (mid-gray), matching
  PaddleOCR's `resize_norm_img` padding; batches are chunks of ≤ 16 variants.
- **Worker protocol (message API fixed by the dispatch; replies were not):**
  replies are `{ kind: 'polys', polys }`, `{ kind: 'text', results }`,
  `{ kind: 'error', message }`; requests are processed strictly in arrival
  order via a promise chain so replies correspond 1:1 without correlation
  ids. `recognize` carries an optional `lite?: boolean` because the zh
  mapping depends on the lite setting and the stated request shape has no
  other channel (lite never changes ja/ko, which have no tiny recognizer in
  the registry).
- **ort.ts:** `warmupCachedModels` warms EVERY cached det model with one 64×64
  dummy inference ("one dummy det inference" per cached det model, since the
  lite setting picks between them at runtime) and creates sessions for cached
  rec models; warmup failures are logged, never thrown. `getSession` memoizes
  per registry id and deletes a failed promise so a later attempt can retry
  after the model is downloaded. `runSession` adapts a real session to the
  structural `OrtRunner` (single-input PP-OCR models: feed key = first input
  name). `spawnOcrWorker` added here per §7.0 ("ort.ts owns … worker spawn"),
  same Vite worker-URL pattern as s8's `local.ts`.
- **MODEL_REGISTRY dict URLs 404 on the media CDN (flagged, cross-slice):**
  the .onnx files are Git-LFS objects served by
  media.githubusercontent.com/media, but the dict .txt files are plain git
  blobs and the media CDN 404s for them (verified for ppocrv6_tiny_dict.txt,
  japan_dict.txt, ppocrv5_korean_dict.txt); raw.githubusercontent.com serves
  the identical file. `tests/int/ocr.int.test.ts` tries the registry URL
  first and falls back to the raw CDN for the SAME repo/branch/path. The
  shipped registry (s2's file, not editable in s4) needs the same fallback or
  URL fix for the options-page dict downloads to work.
- **MODEL_REGISTRY byte constants don't match the real files (flagged,
  cross-slice):** actual sizes are det-tiny 1,780,590 B (registry 1,048,576),
  rec-zh-tiny 4,462,639 B (registry 4,194,304); dict-zh-tiny matches
  (27,157). The §7.9 comment says the listed bytes "are the shipped numbers",
  so AC7's consent dialog would show wrong sizes. The integration test logs
  the mismatch instead of asserting it; the registry belongs to s2.
- **Fixture PNG decoding:** the integration test decodes
  tests/fixtures/bubble.png (760×240, 8-bit RGB, non-interlaced) with a
  minimal in-test PNG decoder over node's zlib — no new dependencies (§9).

## s9 — pipeline orchestrator + extension shell (2026-10-04)

- **imageBlob transport (`pngB64`):** Chromium extension messaging JSON-serializes messages, so §7.1's imageBlob `buf: ArrayBuffer` cannot cross `tabs.sendMessage` on Chromium (Firefox's structured clone would carry it). The composite therefore also travels as base64 PNG in a `pngB64` field added to the imageBlob variant in `shared/messages.ts` (`shared/types.ts` untouched; `buf` becomes optional there). Content renders pngB64 → `Blob` → same-origin `blob:` URL → `img.src` (§6.2). Verified behaviour, not an invention: the type extension is documented in messages.ts.
- **Streaming composite:** after every painted balloon the full composite is re-sent (§6.3 streaming rule + AC5). Per-balloon inpainting runs on a crop (balloon bbox + 64 px margin — covers §7.7's 24 px pad and LaMa's 64 px context) taken from the CURRENT composite so earlier balloons' painted pixels survive the putImageData; unmasked pixels are restored bit-identically.
- **Telea regionality:** Telea also runs per balloon on that crop (the spec forbids full-page runs only for LaMa); the margin far exceeds the radius-3 diffusion neighbourhood, so results match full-image Telea.
- **AC7 consent on the translate path:** the background asks the content script to show an in-page `<dialog>` listing every missing model file with its exact registry byte size before any fetch; cancelling ends the job with OPFS untouched. The dialog's own strings ('Download models', 'Download', 'Cancel') are not §4-bound strings. The answer wait is capped at 10 min; tab navigation removes the waiter via the job abort.
- **Silent paths:** consent denial ends the job with NO badge (no §4 string covers it); the content script reverts its own trigger state (attributes restored, status idle) so the image can be retried. Job aborts (navigation/removal) send no result.
- **Menu enablement:** `contextMenus` has no per-tab state, so 'Restore original image' is enabled globally while ≥1 translated image exists anywhere (persisted in storage.session across background wakeups so the item comes back enabled); the content script re-validates at click time — the clicked `srcUrl` must match a currently-translated image, otherwise it no-ops.
- **imageId:** `crypto.randomUUID()` per `<img>` element (random fallback), unique across tabs; the background job map and translated map are keyed by it.
- **srcUrl semantics:** the translate request carries `img.currentSrc || img.src` (the srcset-selected candidate actually displayed); attributes are captured BEFORE srcset/sizes are removed (§6.2 order); a srcset-only image gets currentSrc pinned onto `src` so pixels stay visible until the blob swap; restore puts all three attributes back verbatim (absent attributes stay absent). `<picture><source>` srcset is not touched (§6.2 names the img's attributes only) — a qualifying `<source>` could still override a blob `src` (limitation).
- **Failure handling:** any hard failure reverts the image to the original attributes (partial composites are discarded) and shows the exact error string; 'Untranslated: N line(s)' keeps the translated image. Error mapping lives in background.ts: s8's `'Backend unavailable'` is normalized to §4's `'Backend unreachable'`; §10 strings ('No text found', 'Storage full', 'Download failed (HTTP n)') pass through; everything else becomes 'Translation failed — retry?' (badge click re-triggers).
- **'done' badge:** the literal 'done' (§6.1) fades after 2 s; the AC2 overlay toggle reuses §4's 'Restore original image' as the hover-reveal label on translated images; the untranslated badge does not auto-fade.
- **SFX gate:** crops with recognition score < `settings.sfxThreshold` are dropped BEFORE clustering (never masked, inpainted or translated); balloons left without lines produce no tag; a page with no confident text reports 'No text found'. Empty recognition strings are dropped as noise.
- **Balloon string join:** a balloon's line texts join with '' for ja/zh (no inter-word spaces in the script) and ' ' for ko, forming the single tag string §6.4 expects.
- **Tag numbering:** restarts at 1 per ≤48-tag chunk (each chunk is its own §6.4 conversation); tags map back via the chunk offset; out-of-range or duplicate tags are ignored (first commit wins — runTranslate dedupes too).
- **CONTEXT source:** `previous` = the last 12 committed translations, kept in the background module across jobs ("previous page" when translating consecutive pages); within a page, later chunks see earlier chunks' commits. Lost when the background wakes (best-effort).
- **Timings:** `llmFirstMs` = first chunk's firstMs, `llmTotalMs` = Σ chunk totalMs; inpaint/typeset accumulate across balloons; logged via console.log and carried in the result message (AC3).
- **det double-detection:** a force-cut straddler can be detected in two slices; exact integer-bbox duplicates are dropped (first wins).
- **Worker clients:** the OCR worker replies 1:1 in arrival order (s4) → FIFO matching; the s6 LaMa worker does not serialize its handling → requests are serialized client-side. Both clients poison and respawn their worker on error or timeout (120 s safety nets for OCR and LaMa — never a normal path); a terminated worker's late replies can never mispair.
- **Workers are spawned in background.ts via Vite `?worker` imports** (the s9 dispatch assigns worker spawning to background.ts). `lib/ort.ts`'s `spawnOcrWorker` and `local.ts`'s llm-worker spawn use `new URL(..., import.meta.url)`, which WXT's global `import.meta.url → self.location.href` define prevents Vite from transforming (verified against a stock Vite build) — the emitted path would 404 at runtime. **BLOCKER (cross-slice):** `lib/ort.ts` and `core/translate/local.ts` should switch to `?worker` imports (or wxt.config.ts must stop the global define); until then the `local` backend cannot spawn its worker in the built extension (remote/nano are unaffected).
- **BLOCKER (ORT wasm):** the same define also prevents Vite from emitting onnxruntime-web's `ort-wasm-simd-threaded.jsep.wasm` (verified: stock Vite emits it as an asset; with the define, the bundled workers compute `assets/ort-wasm-simd-threaded.jsep.wasm` at runtime and 404). OCR/LaMa session creation fails in the built extension until wxt.config.ts stops the global define or `lib/ort.ts` + `lama.worker.ts` set `env.wasm.wasmPaths` to a shipped wasm copy. (wxt-config / s4 / s6 owners.)
- **Pre-existing flags carried forward (s4):** MODEL_REGISTRY dict URLs 404 on the media CDN (translate-time dict downloads fail with 'Download failed (HTTP 404)'; raw.githubusercontent.com serves the same files) and the registry byte constants do not match the real files (AC7 consent sizes wrong). Both belong to s2's file.
- **Keepalive:** while jobs run, `browser.runtime.getPlatformInfo()` every 20 s keeps the MV3 service worker / Firefox event page alive during long local-LLM generations; module state (job map, backends, workers, previous context) resets on a wake — translated ids are persisted in storage.session, running jobs are not.
- **Per-site srcLang:** the popup quick selector routes through the content script (`{ kind: 'setSrcLang' }`), which writes `storage.local` `perSiteSrcLang`[location.hostname] AND the global `settings.srcLang`; the background resolves `perSite[hostname] ?? settings.srcLang` at job start via `tabs.get(tabId).url` (host_permissions `<all_urls>`; falls back to the global default when no URL is visible). §7.1's BgRequest stays untouched — it carries no srcLang field, which is why the resolution happens in the background.
- **Popup status:** 'Backend: <kind>' (+ the remoteUrl for remote); the last failure string is shown with the URL (§6.5). The translate button reuses the toolbar path (largest visible image) and surfaces 'No image found' when nothing is found or no content script exists.
- **Nano fallback:** at job start, backend 'nano' without the `LanguageModel` global falls back to 'local' (§10); an async `availability()` failure mid-job surfaces as the generic retryable error.
- **Warmup:** `requestIdleCallback` (15 s setTimeout fallback) calls `warmupCachedModels()` — cached models only (§7.0).
- **AC6:** no new egress — image bytes are fetched in the background and stay local; downloads use registry URLs; remote chat completions go to the user-configured endpoint; nothing else fetches. (Observed, pre-existing: transformers.js defaults its ORT wasm download to a jsdelivr CDN when `wasmPaths` is unset — an s8 concern surfaced by this audit.)

## fixB — real settings editor on the options page (2026-10-04)

- **`nanoAvailable()` import path:** the fixB dispatch cites
  `src/core/translate/backend.ts`, but the export actually lives in
  `src/core/translate/nano.ts` (backend.ts only mentions it in a comment, and
  backend.ts is outside this slice's allowed files); imported from nano.ts.
- **`remoteApiKey` persistence:** `shared/types.ts` `Settings` /
  `DEFAULT_SETTINGS` still lack `remoteApiKey` (SPEC §7.1 names it; `remote.ts`
  does not read it yet — pre-existing s1/s8 drift, not fixable under fixB's
  file list). The editor persists it as an extra property of the SAME
  `'settings'` object through the existing `loadSettings`/`saveSettings`
  helpers (the spread in both directions preserves unknown keys through
  storage.sync JSON), read via `Settings & { remoteApiKey?: string }`. Once
  the type/remote owner adds the field, the stored value flows unchanged.
- **remoteUrl placeholder:** the field placeholder is
  `https://translator.mangal-coolify.duckdns.org/v1` (fixB dispatch + SPEC
  §7.1 comment), superseding A5's `http://localhost:8081/v1` placeholder text;
  A5's `remoteUrl` default `''` is unaffected.
- **URL validation semantics:** empty `remoteUrl` is valid (it is the default);
  a non-empty value must match `/^https?:\/\//` or the exact inline error
  `URL must start with http:// or https://` is shown and the invalid text is
  NOT persisted — the last valid URL stays in storage (validation prevents
  storage, mirroring the glossary's skip-on-save rule).
- **Glossary '=' rule:** with separate src/dst inputs, "contains '=' in the
  wrong place" is read as any '=' inside src OR dst — the only valid '=' is
  the conceptual src=dst separator. A row shows `Use src=dst` and is skipped
  on save when src or dst is empty (after trim) or contains '='; values are
  trimmed before validation and save.
- **Empty-row hint:** a pristine empty row shows the hint immediately (the
  literal rule — empty src ⇒ hint); harmless because empty rows are skipped
  on save.
- **sfxThreshold:** parsed with `Number()`; a non-finite value (cleared field)
  keeps the previously stored value, finite values are clamped to [0,1] on
  save (min/max/step only constrain steppers, not typing).
- **Backend fallback on load:** stored `backend: 'nano'` when
  `nanoAvailable()` resolves false — or any unknown stored value — is
  corrected to `'local'` in the UI AND persisted (§10 "if storage says nano,
  fall back to local"); s9's job-start fallback is unchanged and consistent.
- **`remoteModel` not exposed:** the fixB field list does not name it, so no
  editor field was added; the stored value is carried through saves untouched
  (its Qwen2.5 default-value drift stays flagged under s10 for the s1/s8
  owners).
- **Save strategy:** `input` events debounce a save (300 ms); `change` events
  (blur / radio / checkbox / select) and `pagehide` flush immediately.
  Verification: `npm run lint` (tsc strict) clean, `npm run build` (both
  targets) and `npm test` (99/99) green.

## fixC — README to the amended spec (2026-10-04)

- **Model references updated:** local = `onnx-community/Qwen3.5-0.8B-Text-ONNX`
  q4, ~570 MB first download (570,473,438 bytes incl. tokenizer); remote =
  `unsloth/Qwen3.5-0.8B-GGUF` Q4_K_M served by llama-server, request model
  name `qwen3.5-0.8b`, thinking disabled
  (`chat_template_kwargs.enable_thinking: false`, §6.4; `<arg_key>think&gt;…&lt;/think&gt;`
  spans discarded by the parser). Stated in the `local`/`remote` backend
  bullets and in the llama-server section's extension-settings bullet.
- **Download table source:** ids, URLs and byte values were taken verbatim
  from the AMENDED SPEC §7.9 (working tree): `OCR_LFS_BASE` (media CDN) for
  the `.onnx` files, `OCR_RAW_BASE` (raw.githubusercontent.com) for the `.txt`
  dicts, verified byte values per entry, `LOCAL_LLM` = Qwen3.5-0.8B-Text-ONNX
  q4 / 570,473,438. The README table now carries a full per-row URL column
  (base constants expanded) plus the two base URLs in prose.
- **Drift observed at fixC time (not fixable here, src/** out of scope):**
  `src/lib/modelRegistry.ts` at HEAD (last touched b9e3b9e) still carried the
  pre-swap constants — `OCR_BASE` (media CDN for everything incl. dicts),
  det-small 9,437,184 / det-tiny 1,048,576 / rec-zh-small 20,971,520 /
  rec-zh-tiny 4,194,304 / rec-ja 9,437,184 / rec-ko 12,582,912, and
  `LOCAL_LLM` = Qwen2.5-1.5B-Instruct / 1,787,566,590. No registry commit or
  working-tree change appeared during fixC (polled ~6 min total). The README
  documents the binding amended §7.9 values; the registry owner (fixA) must
  land the identical constants so file and README agree. The fixB-era drift
  flags on `remoteModel` / `local.ts` / `llm.worker.ts` remain open for their
  owners; the README intentionally documents the §6.4/§7.1 spec value
  `qwen3.5-0.8b`, not the drifted code default.
- **Human-readable size corrections (options-page formula `toFixed(1)`,
  MB = MiB / KB = KiB):** `lama` 196.8 → **196.7 MB** (206,291,843 B = 196.735
  MiB) and local LLM 544.2 → **544.0 MB** (570,473,438 B = 544.046 MiB) — the
  old values were mis-rounded. First-run consent example recomputed for the
  amended bytes: det-small + rec-ja + dict-ja = 19,929,782 B ≈ **19 MB** (was
  ≈18 MB under the old registry values). MiB conversions for every row were
  recomputed and checked against the options page's `formatSize`.
- **LLM row URL (assumption taken):** the "fetched from" cell for the local
  LLM row is `https://huggingface.co/onnx-community/Qwen3.5-0.8B-Text-ONNX` —
  the canonical HF repo URL of the §7.9 `LOCAL_LLM.repo` id (the registry
  stores only the repo id; Transformers.js resolves it against the HF hub,
  per A4/AC6 "the local LLM from its Hugging Face repo"). Not a new egress
  claim — same host already named in the privacy note.
- **Settings section rewritten as shipped (fixB):** the "settings editor is
  still a placeholder list" wording is removed; the README now describes the
  real editor — backend (nano only when available, AC9), srcLang, fixed
  target language, inpaint radios, lite, sfxThreshold, remoteUrl (validated,
  inline error, invalid text not persisted), remoteApiKey, glossary editor
  (`Use src=dst` hint, skip-on-save) — plus the Models section and the
  `settings` storage.sync key. Placeholder text observed in the shipped
  markup is the Coolify URL (fixB's note supersedes A5's localhost
  placeholder); not restated numerically in the README beyond §7.12's
  remoteUrl.
- **Kept verbatim:** install steps (`npm run build` both targets; Firefox-only
  via `npx wxt build -b firefox`), Chromium load-unpacked, Firefox
  temporary-install steps, limitations (vertical JP best-effort A1, SFX
  confidence rule A3), privacy note, credits.
- **Verification:** scripted comparison of the README table against amended
  §7.9 — all 11 registry rows (id/file/URL/bytes) and the LLM row (repo/dtype/
  bytes) identical; llama-server command block byte-identical to §7.12; stale
  strings (Qwen2/qwen2, old byte values, "placeholder", "stub") absent.
  `npm run build` (both targets) green after the edits.
