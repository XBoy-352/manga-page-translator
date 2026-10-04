// Background shell (docs/SPEC.md §6.1, §6.2, §6.5, §7.11): 'Translate image' /
// 'Restore original image' context menus (image contexts only), toolbar action
// targeting, the content ⇄ background message router, background fetch of the
// image bytes (host permissions bypass CORS), the per-image job map with
// duplicate-trigger no-ops and abort-on-navigation/close, worker orchestration
// through core/pipeline with per-stage timings, and idle warmup (§7.0).

import { runPipeline, type PipelineDeps } from '../core/pipeline';
import { createBackend, type TranslateBackend } from '../core/translate/backend';
import type { Polygon } from '../core/det';
import type { RecResult } from '../core/rec';
import { registerFont } from '../core/typeset';
import { cachedIds, fetchToOpfs } from '../lib/modelCache';
import { MODEL_REGISTRY, type ModelEntry } from '../lib/modelRegistry';
import { warmupCachedModels } from '../lib/ort';
// Workers are spawned here (background.ts owns worker spawn per the s9
// dispatch). Vite's `?worker` import is used instead of lib/ort.ts's
// spawnOcrWorker / local.ts's `new URL(..., import.meta.url)` pattern because
// WXT defines `import.meta.url` to `self.location.href` globally, which
// prevents Vite from transforming worker URLs into emitted chunks — the
// `?worker` import produces real chunk files that work under MV3 CSP.
import OcrWorkerCtor from '../worker/ocr.worker?worker';
import LamaWorkerCtor from '../worker/lama.worker?worker';
import type { OcrWorkerIn, OcrWorkerOut } from '../worker/ocr.worker';
import { loadSettings } from '../shared/settings';
import type {
  BgRequest,
  BgResponse,
  ConsentRequest,
  ConsentResult,
  ContentRequest,
  PopupRequest,
  PopupResponse,
} from '../shared/messages';
import type { ProgressEvent, Settings, SrcLang } from '../shared/types';

const MENU_TRANSLATE = 'mpt-translate-image';
const MENU_RESTORE = 'mpt-restore-original-image';
/** A6: per-hostname srcLang memory in storage.local. */
const PER_SITE_KEY = 'perSiteSrcLang';
const BYTES_PER_MB = 1024 * 1024;
/** Safety net for the LaMa worker (session load + patches); never a normal path. */
const LAMA_TIMEOUT_MS = 120_000;
/** Safety net for the OCR worker (model load + inference); never a normal path. */
const OCR_TIMEOUT_MS = 120_000;
/** Safety net for the AC7 consent dialog (the user may simply walk away). */
const CONSENT_TIMEOUT_MS = 600_000;
/** Idle-warmup and keepalive cadence. */
const WARMUP_IDLE_MS = 15_000;
const KEEPALIVE_MS = 20_000;

// §6.2: the image bytes are fetched in the background context — host
// permissions (<all_urls>) bypass CORS there.
// The font is imported with Vite's `?url` syntax: WXT redefines
// `import.meta.url`, which breaks `new URL(asset, import.meta.url)` asset
// resolution at build time (same reason the workers use `?worker`).
import fontUrl from '../assets/fonts/comic-neue-bold.ttf?url';

export default defineBackground(() => {
  // ---- context menus (§6.1: image contexts only; restore starts disabled) ----
  // Menu creation is async (removeAll → create); the translated-state restore
  // and the first enabled-update are chained after it so the update cannot
  // race ahead of the items existing.
  void browser.contextMenus
    .removeAll()
    .then(() => {
      browser.contextMenus.create({ id: MENU_TRANSLATE, title: 'Translate image', contexts: ['image'] });
      browser.contextMenus.create({
        id: MENU_RESTORE,
        title: 'Restore original image',
        contexts: ['image'],
        enabled: false,
      });
      return restoreTranslatedState();
    })
    .then(updateRestoreMenu)
    .catch((e: unknown) => console.warn('[mpt] context menu setup failed:', e));
  browser.contextMenus.onClicked.addListener(onMenuClicked);
  browser.action.onClicked.addListener(onActionClicked);
  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onRemoved.addListener((tabId) => {
    abortTabJobs(tabId);
    dropTabTranslations(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, info) => {
    // A navigation tears the page's images down: abort pending jobs (§6.2) and
    // forget that tab's translated images.
    if (info.status === 'loading' || info.url !== undefined) {
      abortTabJobs(tabId);
      dropTabTranslations(tabId);
    }
  });

  // ---- idle warmup of cached models (§7.0) ----
  const idle = (cb: () => void): void => {
    const ric = (self as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(cb, { timeout: 30_000 });
    else setTimeout(cb, WARMUP_IDLE_MS);
  };
  idle(() => {
    void warmupCachedModels();
  });

  // Translated-image bookkeeping survives event-page/service-worker wakeups so
  // the restore menu item comes back enabled (storage.session, best effort).
  // (Restored inside the menu-setup chain above.)
});

// ---------------------------------------------------------------------------
// Job state (per-image, §8: "per-image job map with cancellation")
// ---------------------------------------------------------------------------

interface Job {
  imageId: string;
  tabId: number;
  abort: AbortController;
}

const jobs = new Map<string, Job>();
/** imageId → tabId for images whose composite the content script applied. */
const translated = new Map<string, number>();
const tabJobs = new Map<number, Set<string>>();
const consentWaiters = new Map<string, (approved: boolean) => void>();
/** Exact badge string of the last failed job (popup status line, §6.5). */
let lastError: string | null = null;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(): void {
  // A long local-LLM generation has no extension-message traffic; periodic API
  // calls keep the MV3 service worker / Firefox event page alive mid-job.
  if (keepaliveTimer !== null) return;
  keepaliveTimer = setInterval(() => {
    void browser.runtime.getPlatformInfo().catch(() => undefined);
  }, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (jobs.size > 0) return;
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function abortTabJobs(tabId: number): void {
  const ids = tabJobs.get(tabId);
  if (!ids) return;
  tabJobs.delete(tabId);
  for (const imageId of ids) {
    jobs.get(imageId)?.abort.abort(); // silent abort (§10: no badge, no error)
    jobs.delete(imageId);
    consentWaiters.delete(imageId);
  }
  stopKeepalive();
}

function dropTabTranslations(tabId: number): void {
  let changed = false;
  for (const [imageId, owner] of translated) {
    if (owner === tabId) {
      translated.delete(imageId);
      changed = true;
    }
  }
  if (changed) {
    updateRestoreMenu();
    void persistTranslatedState();
  }
}

function markTranslated(imageId: string, tabId: number): void {
  translated.set(imageId, tabId);
  updateRestoreMenu();
  void persistTranslatedState();
}

function unmarkTranslated(imageId: string): void {
  if (!translated.delete(imageId)) return;
  updateRestoreMenu();
  void persistTranslatedState();
}

function updateRestoreMenu(): void {
  // contextMenus has no per-tab state; the item is enabled while any translated
  // image exists, and the content script re-validates at click time (§6.1).
  void browser.contextMenus
    .update(MENU_RESTORE, { enabled: translated.size > 0 })
    .catch(() => undefined);
}

async function persistTranslatedState(): Promise<void> {
  try {
    const byTab: Record<string, string[]> = {};
    for (const [imageId, tabId] of translated) (byTab[tabId] ??= []).push(imageId);
    await browser.storage.session.set({ translatedByTab: byTab });
  } catch {
    // storage.session unavailable — menu state resets on the next wakeup.
  }
}

async function restoreTranslatedState(): Promise<void> {
  try {
    const stored = await browser.storage.session.get('translatedByTab');
    const byTab = stored['translatedByTab'] as Record<string, string[]> | undefined;
    if (!byTab) return;
    for (const [tabId, ids] of Object.entries(byTab)) {
      for (const imageId of ids) translated.set(imageId, Number(tabId));
    }
  } catch {
    // ignore — best-effort persistence only.
  }
}

// ---------------------------------------------------------------------------
// Toolbar action (§6.1) and context menus
// ---------------------------------------------------------------------------

async function onActionClicked(tab: Browser.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  try {
    const reply = (await browser.tabs.sendMessage(tab.id, {
      kind: 'actionTranslate',
    } satisfies ContentRequest)) as { kind: 'actionResult'; found: boolean } | undefined;
    if (!reply || reply.kind !== 'actionResult' || !reply.found) showActionBounce(tab.id);
  } catch {
    showActionBounce(tab.id); // no content script / no image
  }
}

/** §6.1: action badge `!` for 2 s, tooltip `No image found`. */
function showActionBounce(tabId: number): void {
  void browser.action.setBadgeBackgroundColor({ color: '#b3261e', tabId }).catch(() => undefined);
  void browser.action.setBadgeText({ text: '!', tabId }).catch(() => undefined);
  void browser.action.setTitle({ title: 'No image found', tabId }).catch(() => undefined);
  setTimeout(() => {
    void browser.action.setBadgeText({ text: '', tabId }).catch(() => undefined);
    void browser.action.setTitle({ title: '', tabId }).catch(() => undefined);
  }, 2000);
}

function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): void {
  if (tab?.id === undefined) return;
  const srcUrl = info.srcUrl;
  if (!srcUrl) return;
  if (info.menuItemId === MENU_TRANSLATE) {
    void browser.tabs
      .sendMessage(tab.id, { kind: 'menuTranslate', srcUrl } satisfies ContentRequest)
      .catch(() => undefined);
  } else if (info.menuItemId === MENU_RESTORE) {
    void browser.tabs
      .sendMessage(tab.id, { kind: 'menuRestore', srcUrl } satisfies ContentRequest)
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Message router (§7.1 BgRequest + consent answers + popup status)
// ---------------------------------------------------------------------------

function onMessage(
  raw: unknown,
  sender: Browser.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  const msg = raw as { kind?: string } | null | undefined;
  if (!msg || typeof msg.kind !== 'string') return undefined;
  if (msg.kind === 'translate' || msg.kind === 'restore') {
    void handleBgRequest(msg as unknown as BgRequest, sender);
    return undefined; // progress/result flow asynchronously via tabs.sendMessage
  }
  if (msg.kind === 'consentResult') {
    const consent = msg as unknown as ConsentResult;
    consentWaiters.get(consent.imageId)?.(consent.approved);
    consentWaiters.delete(consent.imageId);
    return undefined;
  }
  if (msg.kind === 'getStatus') {
    void getStatus().then(
      (status: PopupResponse) => sendResponse(status),
      () => sendResponse({ kind: 'status', backend: 'local', remoteUrl: '', lastError: lastError }),
    );
    return true; // async sendResponse
  }
  return undefined;
}

async function handleBgRequest(req: BgRequest, sender: Browser.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (req.kind === 'restore') {
    unmarkTranslated(req.imageId);
    // Also cancels a running job (mid-run image removal reuses this path).
    jobs.get(req.imageId)?.abort.abort();
    jobs.delete(req.imageId);
    stopKeepalive();
    return;
  }
  await startJob(req, tabId);
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

async function startJob(req: Extract<BgRequest, { kind: 'translate' }>, tabId: number): Promise<void> {
  // §6.1: duplicate trigger while running, or on an already-translated image
  // (until restored), is a no-op.
  if (jobs.has(req.imageId) || translated.has(req.imageId)) return;

  const abort = new AbortController();
  jobs.set(req.imageId, { imageId: req.imageId, tabId, abort });
  let tabIds = tabJobs.get(tabId);
  if (!tabIds) {
    tabIds = new Set();
    tabJobs.set(tabId, tabIds);
  }
  tabIds.add(req.imageId);
  startKeepalive();

  try {
    const settings = await loadSettings();
    const srcLang = await resolveSrcLang(settings, tabId);
    // §10: if storage says nano but the API is absent, fall back to local.
    const effective: Settings =
      settings.backend === 'nano' && !('LanguageModel' in self)
        ? { ...settings, srcLang, backend: 'local' }
        : { ...settings, srcLang };

    if (!(await ensureModels(effective, req.imageId, tabId, abort.signal))) return; // denied → silent (AC7)
    const image = await fetchImage(req.srcUrl, abort.signal);
    const font = await getFont();
    const deps = buildDeps(effective);

    const send = (message: BgResponse | ConsentRequest): void => {
      void browser.tabs.sendMessage(tabId, message).catch(() => undefined);
    };
    const emitProgress = (event: ProgressEvent): void => send({ kind: 'progress', event });

    // Streaming composites must reach the content script in commit order.
    let encodeChain: Promise<void> = Promise.resolve();
    let firstBlobSent = false;
    const onComposite = (rgba: ArrayBuffer, width: number, height: number): void => {
      encodeChain = encodeChain
        .then(async () => {
          const pngB64 = await encodePngBase64(rgba, width, height);
          send({ kind: 'imageBlob', imageId: req.imageId, width, height, pngB64 });
          if (!firstBlobSent) {
            firstBlobSent = true;
            markTranslated(req.imageId, tabId);
          }
        })
        .catch((e: unknown) => console.warn('[mpt] composite encode failed:', e));
    };

    const result = await runPipeline({
      imageId: req.imageId,
      image,
      settings: effective,
      font,
      deps,
      callbacks: { onProgress: emitProgress, onComposite },
      signal: abort.signal,
    });
    await encodeChain;

    lastError = null;
    console.log(`[mpt] job ${req.imageId} timings`, result.timings); // AC3
    send({
      kind: 'result',
      imageId: req.imageId,
      ok: true,
      width: image.width,
      height: image.height,
      timings: result.timings,
    });
  } catch (e) {
    if (abort.signal.aborted) return; // §6.2/§10: silent abort, no badge, no error
    const error = badgeError(e);
    lastError = error;
    console.warn(`[mpt] job ${req.imageId} failed:`, e);
    void browser.tabs
      .sendMessage(tabId, { kind: 'result', imageId: req.imageId, ok: false, error } satisfies BgResponse)
      .catch(() => undefined);
  } finally {
    jobs.delete(req.imageId);
    tabJobs.get(tabId)?.delete(req.imageId);
    consentWaiters.delete(req.imageId);
    stopKeepalive();
  }
}

/**
 * Exact badge strings (§4/§6.5/§10). Anything unmapped becomes the generic
 * retryable failure.
 */
function badgeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw === 'Backend unavailable') return 'Backend unreachable'; // s8 remote.ts string → §4 string
  if (/^(Backend unreachable|No text found|Storage full|Download failed \(HTTP \d+\))$/.test(raw)) return raw;
  return 'Translation failed — retry?';
}

/** A6: perSiteSrcLang[hostname] overrides the global default on that hostname. */
async function resolveSrcLang(settings: Settings, tabId: number): Promise<SrcLang> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url) {
      const hostname = new URL(tab.url).hostname;
      if (hostname) {
        const stored = await browser.storage.local.get(PER_SITE_KEY);
        const map = stored[PER_SITE_KEY] as Record<string, SrcLang> | undefined;
        const perSite = map?.[hostname];
        if (perSite === 'ja' || perSite === 'ko' || perSite === 'zh') return perSite;
      }
    }
  } catch {
    // No URL visibility / no such tab — fall through to the global default.
  }
  return settings.srcLang;
}

/** AC7: consent for every required-but-uncached model, then download with progress.
 * Resolves false when the user denies consent (nothing cached, job ends silently).
 */
async function ensureModels(
  settings: Settings,
  imageId: string,
  tabId: number,
  signal: AbortSignal,
): Promise<boolean> {
  const required = requiredModels(settings);
  const cached = await cachedIds();
  const missing = required.filter((entry) => !cached.has(entry.id));
  if (missing.length === 0) return true;

  const approved = await requestConsent(tabId, imageId, missing, signal);
  if (!approved) return false; // cancelling leaves OPFS untouched (AC7)

  const send = (message: BgResponse): void => {
    void browser.tabs.sendMessage(tabId, message).catch(() => undefined);
  };
  const totalMb = missing.reduce((sum, entry) => sum + entry.bytes / BYTES_PER_MB, 0);
  let doneMb = 0;
  for (const entry of missing) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await fetchToOpfs(entry, (mb) => {
      send({
        kind: 'progress',
        event: { imageId, stage: 'download', done: doneMb + mb, total: totalMb },
      });
    }, signal);
    doneMb += entry.bytes / BYTES_PER_MB;
  }
  return true;
}

function requiredModels(settings: Settings): ModelEntry[] {
  const ids = [settings.lite ? 'det-tiny' : 'det-small'];
  if (settings.srcLang === 'ja') ids.push('rec-ja', 'dict-ja');
  else if (settings.srcLang === 'ko') ids.push('rec-ko', 'dict-ko');
  else ids.push(settings.lite ? 'rec-zh-tiny' : 'rec-zh-small', settings.lite ? 'dict-zh-tiny' : 'dict-zh-small');
  if (settings.inpaint === 'lama') ids.push('lama');
  return MODEL_REGISTRY.filter((entry) => ids.includes(entry.id));
}

function requestConsent(
  tabId: number,
  imageId: string,
  files: ModelEntry[],
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const finish = (approved: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(approved);
    };
    const onAbort = (): void => {
      consentWaiters.delete(imageId);
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      consentWaiters.delete(imageId);
      reject(new Error('Consent dialog timed out'));
    }, CONSENT_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    consentWaiters.set(imageId, finish);
    const request: ConsentRequest = {
      kind: 'consentRequest',
      imageId,
      files: files.map((entry) => ({
        id: entry.id,
        name: entry.url.slice(entry.url.lastIndexOf('/') + 1),
        bytes: entry.bytes,
      })),
    };
    void browser.tabs.sendMessage(tabId, request).catch(() => {
      consentWaiters.delete(imageId);
      clearTimeout(timer);
      reject(new Error('Consent dialog unavailable'));
    });
  });
}

/** §6.2: fetch the image bytes in the background (host permissions bypass CORS). */
async function fetchImage(srcUrl: string, signal: AbortSignal): Promise<ImageData> {
  const res = await fetch(srcUrl, { signal });
  if (!res.ok) throw new Error(`Image fetch failed (HTTP ${res.status})`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  if (bmp.width <= 0 || bmp.height <= 0) {
    bmp.close();
    throw new Error('empty image');
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bmp.close();
    throw new Error('OffscreenCanvas 2D context unavailable');
  }
  ctx.drawImage(bmp, 0, 0);
  const image = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return image;
}

let fontPromise: Promise<FontFace> | null = null;

function getFont(): Promise<FontFace> {
  fontPromise ??= fetch(fontUrl)
    .then((res) => res.arrayBuffer())
    .then((bytes) => registerFont(bytes));
  return fontPromise;
}

// Backends are cached per identity so the local LLM worker (spawned inside
// LocalBackend) stays warm across pages instead of reloading 1.7 GB per job.
const backends = new Map<string, TranslateBackend>();

function getBackend(settings: Settings): TranslateBackend {
  const key = `${settings.backend}|${settings.remoteUrl}|${settings.remoteModel}`;
  let backend = backends.get(key);
  if (!backend) {
    backend = createBackend(settings);
    backends.set(key, backend);
  }
  return backend;
}

function buildDeps(settings: Settings): PipelineDeps {
  return {
    detect: (slice) => getOcrClient().detect(slice, settings.lite ? 'det-tiny' : 'det-small'),
    recognizeBatch: (crops, lang, lite) => getOcrClient().recognize(crops, lang, lite),
    inpaintLama: (crop, mask) => getLamaClient().inpaint(crop, mask),
    backend: getBackend(settings),
  };
}

// ---------------------------------------------------------------------------
// Worker clients (the workers themselves are spawned here, §7.0)
// ---------------------------------------------------------------------------

let ocrClient: OcrClient | null = null;

/** Singleton per live worker: the client owns that worker's onmessage routing.
 * A poisoned client (worker dead or a reply timed out) is discarded so the
 * next OCR call spawns a fresh worker instead of hanging or mispairing. */
function getOcrClient(): OcrClient {
  if (ocrClient?.poisoned) ocrClient = null;
  ocrClient ??= new OcrClient(new OcrWorkerCtor());
  return ocrClient;
}

let lamaClient: LamaClient | null = null;

function getLamaClient(): LamaClient {
  // A poisoned client (worker dead or a reply timed out) is discarded so the
  // next inpaint spawns a fresh worker instead of mispairing late replies.
  if (lamaClient?.poisoned) lamaClient = null;
  lamaClient ??= new LamaClient(new LamaWorkerCtor());
  return lamaClient;
}

/**
 * OCR worker client. The worker processes requests strictly in arrival order
 * and replies 1:1 (s4), so replies are matched by order, not by id. A reply
 * timeout (or worker failure) fails every pending request and poisons the
 * client — getOcrClient then spawns a fresh worker.
 */
class OcrClient {
  private pending: ((msg: OcrWorkerOut) => void)[] = [];
  poisoned = false;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<OcrWorkerOut>) => this.pending.shift()?.(ev.data);
    worker.onerror = (ev: ErrorEvent) => this.failAll(ev.message || 'OCR worker failed');
  }

  async detect(slice: ImageData, modelId: string): Promise<Polygon[]> {
    const buf = slice.data.buffer as ArrayBuffer; // transferred; the slice is a fresh copy
    const reply = await this.request(
      { kind: 'detect', buf, width: slice.width, height: slice.height, modelId },
      [buf],
    );
    if (reply.kind === 'polys') return reply.polys;
    throw new Error(reply.kind === 'error' ? reply.message : 'unexpected OCR reply');
  }

  async recognize(crops: ImageData[], lang: SrcLang, lite: boolean): Promise<RecResult[]> {
    const buffers = crops.map((c) => c.data.buffer as ArrayBuffer);
    const reply = await this.request(
      {
        kind: 'recognize',
        crops: crops.map((c, i) => ({ buf: buffers[i], w: c.width, h: c.height })),
        lang,
        lite,
      },
      buffers,
    );
    if (reply.kind === 'text') return reply.results;
    throw new Error(reply.kind === 'error' ? reply.message : 'unexpected OCR reply');
  }

  private request(req: OcrWorkerIn, transfer: Transferable[]): Promise<OcrWorkerOut> {
    if (this.poisoned) return Promise.resolve({ kind: 'error', message: 'OCR worker failed' });
    return new Promise<OcrWorkerOut>((resolve) => {
      const timer = setTimeout(() => {
        this.worker.terminate(); // late replies must never mispair
        this.failAll('OCR worker timed out');
      }, OCR_TIMEOUT_MS);
      this.pending.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.worker.postMessage(req, transfer);
    });
  }

  private failAll(message: string): void {
    this.poisoned = true;
    const waiters = this.pending.splice(0);
    for (const waiter of waiters) waiter({ kind: 'error', message });
  }
}

/**
 * LaMa worker client. The s6 worker does not serialize its own handling, so
 * requests are strictly serialized here — replies must stay paired with their
 * request (the worker protocol has no correlation ids).
 */
class LamaClient {
  private chain: Promise<unknown> = Promise.resolve();
  poisoned = false;

  constructor(private readonly worker: Worker) {}

  inpaint(crop: ImageData, mask: Uint8Array): Promise<ImageData> {
    const attempt = (): Promise<ArrayBuffer> =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The worker may still reply later; terminate so the late reply can
          // never mispair with a subsequent request.
          this.poisoned = true;
          this.worker.terminate();
          reject(new Error('LaMa inpaint timed out'));
        }, LAMA_TIMEOUT_MS);
        this.worker.onmessage = (ev: MessageEvent) => {
          clearTimeout(timer);
          resolve(ev.data as ArrayBuffer);
        };
        this.worker.onerror = (ev: ErrorEvent) => {
          clearTimeout(timer);
          this.poisoned = true;
          reject(new Error(ev.message || 'LaMa worker failed'));
        };
        const buf = crop.data.buffer as ArrayBuffer; // transferred; fresh copies
        const maskBuf = mask.buffer as ArrayBuffer;
        this.worker.postMessage({ buf, width: crop.width, height: crop.height, maskBuf }, [buf, maskBuf]);
      });
    const next = this.chain.then(attempt, attempt);
    this.chain = next.catch(() => undefined);
    return next.then((buf) => new ImageData(new Uint8ClampedArray(buf), crop.width, crop.height));
  }
}

// ---------------------------------------------------------------------------
// Popup status (§6.5: the popup shows the backend failure string with the URL)
// ---------------------------------------------------------------------------

async function getStatus(): Promise<PopupResponse> {
  const settings = await loadSettings();
  return { kind: 'status', backend: settings.backend, remoteUrl: settings.remoteUrl, lastError };
}

// ---------------------------------------------------------------------------
// Composite transport (§6.2 + §7.1 imageBlob)
// ---------------------------------------------------------------------------

/**
 * Encodes the streaming composite as base64 PNG for the imageBlob message —
 * Chromium extension messaging JSON-serializes, so raw ArrayBuffers cannot
 * cross tabs.sendMessage (see docs/ASSUMPTIONS.md).
 */
async function encodePngBase64(rgba: ArrayBuffer, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
