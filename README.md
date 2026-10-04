# Manga Page Translator

A Manifest-V3 browser extension for **Firefox and Chromium** (one codebase, two
builds) that replaces the text inside speech bubbles of a manga page **already
open in the current tab**. Right-click an image → **Translate image** → the
same image comes back with the original glyphs removed and the English
translation typeset into the bubbles. One click restores the original pixels.

- **Everything pixel-related runs on-device**: slicing, OCR (PP-OCR ONNX
  models via onnxruntime-web), balloon clustering, inpainting (Telea default,
  LaMa quality toggle) and typesetting. WebGPU is used when present and never
  required (WASM fallback).
- **Translation** goes through a pluggable backend: `local` Qwen3.5-0.8B
  in-browser via Transformers.js (default), a user-configured
  OpenAI-compatible endpoint (`remote`), or Chrome's built-in `nano` when the
  browser exposes it.
- No account, no analytics, no telemetry. No image ever leaves the machine —
  only the translated *text* goes to a backend the user configured.

## Build

Node ≥ 20.

```bash
npm ci
npm run build        # → .output/chrome-mv3/ and .output/firefox-mv3/
```

`npm run build` produces both targets. To build only the Firefox target:
`npx wxt build -b firefox`. (`npm run build -b firefox` does not work — npm
intercepts `-b` as its own flag.)

Unit tests: `npm test`. The Firefox build passes
`npx web-ext lint --source-dir .output/firefox-mv3` with **0 errors**.

## Install — Firefox (temporary add-on)

Temporary installs are unsigned and removed when Firefox exits; re-load them
after a restart. This release is not published to any store.

1. Build: `npm run build` (or `npx wxt build -b firefox`).
2. Open `about:debugging`.
3. Click **This Firefox**.
4. Click **Load Temporary Add-on…**.
5. Pick any file inside `.output/firefox-mv3/` (e.g. `manifest.json`).

Tip: `npx web-ext run --source-dir .output/firefox-mv3` performs the same
temporary install automatically on a fresh profile.

## Install — Chromium (load unpacked)

1. Build: `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select `.output/chrome-mv3/`.

## Using the extension

- **Context menu on any image**: `Translate image` runs the pipeline;
  `Restore original image` puts the original pixels back exactly. Both appear
  in the image context menu only.
- **Toolbar button**: targets the largest visible `<img>` in the viewport; if
  none, the action badge shows `!` for 2 s (tooltip `No image found`).
- **Overlay badge on the image** shows progress (`OCR 3/5 · 84 ms`,
  `Downloading models…`), then `done` (fades after 2 s), or one of the exact
  failure strings: `No text found`, `Backend unreachable`,
  `Untranslated: N line(s)`, `Download failed (HTTP n)`, `Storage full`,
  `Translation failed — retry?` (click to retry).
- **Popup** (toolbar icon): backend status line, source-language quick
  selector (JA / KO / ZH — remembered per site), and a *Translate visible
  image* button.
- **Options page**: a **Settings** section — backend (`local` / `remote` /
  `nano`; `nano` appears only when the browser exposes the Prompt API and
  reports it `available`), source language (JA / KO / ZH), target language
  (fixed to English), inpainting mode (Telea / LaMa), Lite mode, SFX threshold
  (0–1), remote URL and remote API key, plus a glossary editor with
  add/remove `src`/`dst` rows (a row that is empty or contains `=` shows the
  inline hint `Use src=dst` and is skipped on save). A non-empty remote URL
  must start with `http://` or `https://`; invalid text shows the inline error
  `URL must start with http:// or https://` and is not persisted. A
  **Models** section lists every downloadable file with its exact size, offers
  per-file download with progress (cancellable), and **Clear models**.
  Settings are stored under the `settings` key in `browser.storage.sync`.

## Translation backends

- **`local` (default)** — Qwen3.5-0.8B (`onnx-community/Qwen3.5-0.8B-Text-ONNX`,
  q4 dtype) runs in the browser via Transformers.js (WebGPU when available,
  else WASM). Zero configuration; the weights download once on first use of
  this backend — ~570 MB (570,473,438 bytes incl. tokenizer) — into the
  browser's default cache. Thinking is disabled
  (`chat_template_kwargs.enable_thinking: false`); any `<arg_key>think&gt;…&lt;/think&gt;`
  span is discarded before line matching.
- **`remote`** — any OpenAI-compatible `POST {remoteUrl}/chat/completions`
  endpoint, e.g. llama-server below. Requests carry the model name
  `qwen3.5-0.8b`, `temperature: 0` and
  `"chat_template_kwargs": { "enable_thinking": false }` (§6.4). Optional
  `remoteApiKey` is sent as `Authorization: Bearer <key>`; HTTP 401/403
  surfaces as `Backend unreachable (check URL and API key)`.
- **`nano`** — Chrome's built-in Prompt API; only offered when the browser
  exposes `LanguageModel` and reports it `available`.

### Serving the backend with llama-server (normative, SPEC §7.12)

Primary deployment — Coolify service on the Oracle A1 VM (aarch64, 4 cores /
24 GB), reverse-proxied by the existing Coolify Traefik:

- Image `ghcr.io/ggml-org/llama.cpp:server` (arm64 variant), attached domain
  `translator.mangal-coolify.duckdns.org` → container port `8081`; Traefik
  terminates TLS. The container binds `0.0.0.0` **inside the Docker network
  only** — no host port is published, so nothing is reachable except via
  Traefik.
- Persistent volume mounted at `/models` holding `Qwen/Qwen3.5-0.8B` (e.g.
  from `unsloth/Qwen3.5-0.8B-GGUF`; llama.cpp supports the Qwen3.5
  Gated-DeltaNet operator since PR #19504).
- Service command:

```bash
--host 0.0.0.0 --port 8081 -c 4096 -np 2 \
  -m /models/Qwen3.5-0.8B-Q4_K_M.gguf \
  --api-key $LLAMA_API_KEY --no-webui
```

- Extension settings: `remoteUrl`
  `https://translator.mangal-coolify.duckdns.org/v1`, `remoteApiKey` set to
  `$LLAMA_API_KEY`. Requests carry the model name `qwen3.5-0.8b` and
  `"chat_template_kwargs": { "enable_thinking": false }` (§6.4); the
  streaming parser discards `<arg_key>think&gt;…&lt;/think&gt;` spans before line matching.

**Private alternative (no public exposure):** run the same binary on the VM
host bound to the Tailscale/private address only, and set `remoteUrl` to
`http://<PRIVATE_IP>:8081/v1`. Port 8080 on the VM belongs to Traefik and is
never used for llama-server.

## First-run model downloads

Nothing is fetched before you confirm: the first translation (or a download
started in the options page) shows a consent dialog listing every file and its
exact size; cancelling leaves storage untouched. Files are cached in the
browser's private storage (OPFS) under `/models/`. Only the models required by
the current settings are requested: the detector (`det-small`, or `det-tiny`
in Lite mode), the recognizer + dictionary for the source language, and
`lama` only in LaMa quality mode. The registry's `.onnx` files are Git-LFS
objects served from the media CDN
(`https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main`);
the `.txt` dictionaries are plain git blobs and come from
`https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main`
(the media CDN 404s them). Sizes below use MB = MiB (1,048,576 B) and
KB = KiB (1,024 B), matching the options page; the exact byte values are the
shipped numbers.

| id | file | fetched from | exact size |
| --- | --- | --- | --- |
| `det-small` | `PP-OCRv6_small_det.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/detection/PP-OCRv6_small_det.onnx` | 9,880,512 B (9.4 MB) |
| `det-tiny` | `PP-OCRv6_tiny_det.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/detection/PP-OCRv6_tiny_det.onnx` | 1,780,590 B (1.7 MB) |
| `rec-zh-small` | `PP-OCRv6_small_rec.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/PP-OCRv6_small_rec.onnx` | 21,159,378 B (20.2 MB) |
| `rec-zh-tiny` | `PP-OCRv6_tiny_rec.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/PP-OCRv6_tiny_rec.onnx` | 4,462,639 B (4.3 MB) |
| `dict-zh-small` | `ppocrv6_dict.txt` | `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/ppocrv6_dict.txt` | 74,948 B (73.2 KB) |
| `dict-zh-tiny` | `ppocrv6_tiny_dict.txt` | `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/ppocrv6_tiny_dict.txt` | 27,157 B (26.5 KB) |
| `rec-ja` | `japan_PP-OCRv3_mobile_rec_infer.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/multi/japan/v3/japan_PP-OCRv3_mobile_rec_infer.onnx` | 10,031,937 B (9.6 MB) |
| `dict-ja` | `japan_dict.txt` | `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/multi/japan/v3/japan_dict.txt` | 17,333 B (16.9 KB) |
| `rec-ko` | `korean_PP-OCRv5_mobile_rec_infer.onnx` | `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx` | 13,443,278 B (12.8 MB) |
| `dict-ko` | `ppocrv5_korean_dict.txt` | `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/multi/korean/v5/ppocrv5_korean_dict.txt` | 47,452 B (46.3 KB) |
| `lama` | `lama-manga-dynamic.onnx` | `https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/main/lama-manga-dynamic.onnx` | 206,291,843 B (196.7 MB) |
| local LLM | `onnx-community/Qwen3.5-0.8B-Text-ONNX` (q4, fetched by Transformers.js) | `https://huggingface.co/onnx-community/Qwen3.5-0.8B-Text-ONNX` | 570,473,438 B (544.0 MB) |

A default first run (Japanese, Telea, non-lite, local backend) therefore asks
consent for `det-small` + `rec-ja` + `dict-ja` (19,929,782 B ≈ 19 MB); the LLM
weights are fetched by Transformers.js on first use of the `local` backend.

## Limitations

- **Vertical Japanese (tategaki) is best-effort** (Assumption A1): tall crops
  are recognized at 0°, 90° and 270° and the best score wins; the Japanese
  recognizer is a horizontal-text model, so vertical accuracy is limited.
- **SFX / captions**: text recognized with confidence below `sfxThreshold`
  (default 0.5) is left untouched (SFX); confident text that is not grouped
  into a balloon (captions) *is* translated (A3).
- Target language is fixed to **English** (A2); no automatic source-language
  detection — pick JA/KO/ZH in the popup.
- `<img>` elements only — no PDF/EPUB/video, no site adapters, no batch
  translation.
- Glossary edits apply on the next page, not mid-translation.
- Firefox without WebGPU runs the WASM path: no time guarantee, progress UI
  is shown, no hard failure.
- No store publishing (AMO / Chrome Web Store) — temporary / load-unpacked
  installs only, as described above.

## Privacy

- No account, no analytics, no telemetry, no crash reporting.
- Every pixel is processed on-device. **Image bytes are never uploaded** — not
  to the translation backend, not anywhere.
- The only network traffic is:
  1. model downloads from the registry sources listed above (and the local
     LLM from its Hugging Face repo on first use of the `local` backend);
  2. translation requests — **text-only** chat messages — to the backend you
     configured.
- The default `local` backend sends nothing anywhere. `remoteApiKey`, when
  set, is sent only to your endpoint as `Authorization: Bearer <key>`.

## Credits

Typesetting font: **Comic Neue Bold**, bundled under the SIL Open Font
License (`src/assets/fonts/OFL.txt`).
