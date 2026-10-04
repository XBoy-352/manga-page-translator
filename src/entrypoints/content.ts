// Content-script shell (docs/SPEC.md §6.1, §6.2, §6.5): saves/restores the
// src + srcset + sizes attributes verbatim, renders streaming composites as
// same-origin blob URLs, shows the overlay badge with the exact §4 strings,
// resolves the largest visible <img> for the toolbar action, routes context
// menu clicks, shows the AC7 download-consent dialog, and keeps the per-site
// srcLang memory (A6).

import { browser } from 'wxt/browser';
import { loadSettings, saveSettings } from '../shared/settings';
import type {
  BgResponse,
  ConsentRequest,
  ConsentResult,
  ContentRequest,
  ContentResponse,
} from '../shared/messages';
import type { BgRequest, ProgressEvent, SrcLang } from '../shared/types';

// §4 status strings — binding, shown verbatim in the overlay badge.
const BADGE_DOWNLOADING = 'Downloading models…';
const BADGE_NO_TEXT = 'No text found';
const BADGE_BACKEND = 'Backend unreachable';
const BADGE_FAILED = 'Translation failed — retry?';
const BADGE_DONE = 'done';
const RESTORE_LABEL = 'Restore original image'; // §4 context-menu label, reused for the overlay toggle

/** A6: per-hostname srcLang memory in storage.local. */
const PER_SITE_KEY = 'perSiteSrcLang';

/** Progress labels for the §6.1 format "stage n/m · N ms" ('OCR 3/5 · 84 ms'). */
const STAGE_LABEL: Partial<Record<ProgressEvent['stage'], string>> = {
  slice: 'Slice',
  det: 'Det',
  rec: 'OCR',
  cluster: 'Cluster',
  translate: 'LLM',
  inpaint: 'Inpaint',
  typeset: 'Typeset',
};

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    interface ImageState {
      id: string;
      img: HTMLImageElement;
      status: 'idle' | 'running' | 'translated';
      saved: { src: string | null; srcset: string | null; sizes: string | null } | null;
      originalSrcUrl: string | null;
      blobUrl: string | null;
      badge: HTMLDivElement | null;
      badgeMode: 'hidden' | 'progress' | 'done' | 'untranslated' | 'error' | 'restoreOffer';
      fadeTimer: ReturnType<typeof setTimeout> | null;
      retryable: boolean;
    }

    const states = new Map<HTMLImageElement, ImageState>();
    const byId = new Map<string, ImageState>();
    let seq = 0;

    function nextImageId(): string {
      seq += 1;
      const crypto = (globalThis as { crypto?: Crypto }).crypto;
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return `img-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2)}`;
    }

    function stateFor(img: HTMLImageElement): ImageState {
      let st = states.get(img);
      if (!st) {
        st = {
          id: nextImageId(),
          img,
          status: 'idle',
          saved: null,
          originalSrcUrl: null,
          blobUrl: null,
          badge: null,
          badgeMode: 'hidden',
          fadeTimer: null,
          retryable: false,
        };
        states.set(img, st);
        byId.set(st.id, st);
        wireHoverToggle(st);
      }
      return st;
    }

    function sendBg(message: BgRequest | ConsentResult): Promise<unknown> {
      return browser.runtime.sendMessage(message);
    }

    // ---------------------------------------------------------------------
    // Trigger / restore (§6.1, §6.2)
    // ---------------------------------------------------------------------

    function triggerTranslate(img: HTMLImageElement): void {
      const st = stateFor(img);
      if (st.status !== 'idle') return; // running / already translated → no-op (§6.1)
      // Capture before mutating: currentSrc reflects the displayed (possibly
      // srcset-selected) candidate — the pixels the background will fetch.
      const srcUrl = img.currentSrc || img.src;
      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;
      if (!srcUrl) return;
      st.status = 'running';
      st.originalSrcUrl = srcUrl;
      // §6.2: store src + srcset + sizes, then remove srcset/sizes.
      st.saved = {
        src: img.getAttribute('src'),
        srcset: img.getAttribute('srcset'),
        sizes: img.getAttribute('sizes'),
      };
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      if (img.getAttribute('src') === null) img.setAttribute('src', srcUrl); // srcset-only image: keep pixels visible
      void sendBg({
        kind: 'translate',
        imageId: st.id,
        srcUrl,
        naturalWidth,
        naturalHeight,
      } satisfies BgRequest).catch(() => {
        // The background could not be reached at all (e.g. extension reloading).
        st.status = 'idle';
        restoreAttributes(st);
        st.saved = null;
        st.originalSrcUrl = null;
        showBadge(st, BADGE_FAILED, 'error', true);
      });
    }

    function restoreImage(img: HTMLImageElement): void {
      const st = states.get(img);
      if (!st || st.status !== 'translated') return;
      restoreAttributes(st);
      st.status = 'idle';
      st.saved = null;
      st.originalSrcUrl = null;
      if (st.blobUrl) {
        URL.revokeObjectURL(st.blobUrl);
        st.blobUrl = null;
      }
      hideBadge(st);
      void sendBg({ kind: 'restore', imageId: st.id } satisfies BgRequest).catch(() => undefined);
    }

    /** Puts src + srcset + sizes back verbatim (§6.2). */
    function restoreAttributes(st: ImageState): void {
      const saved = st.saved;
      if (!saved) return;
      if (saved.src === null) st.img.removeAttribute('src');
      else st.img.setAttribute('src', saved.src);
      if (saved.srcset === null) st.img.removeAttribute('srcset');
      else st.img.setAttribute('srcset', saved.srcset);
      if (saved.sizes === null) st.img.removeAttribute('sizes');
      else st.img.setAttribute('sizes', saved.sizes);
    }

    /** §6.2/§10: image removed mid-run → silent abort (no badge, no error). */
    function handleRemoved(st: ImageState): void {
      states.delete(st.img);
      byId.delete(st.id);
      if (st.fadeTimer !== null) {
        clearTimeout(st.fadeTimer);
        st.fadeTimer = null;
      }
      st.badge?.remove();
      if (st.blobUrl) URL.revokeObjectURL(st.blobUrl);
      if (st.status !== 'idle') {
        // 'restore' doubles as the abort channel for a running job (§7.1).
        void sendBg({ kind: 'restore', imageId: st.id } satisfies BgRequest).catch(() => undefined);
      }
    }

    // Mutation watch: detect mid-run removals even between progress messages.
    let removalCheckQueued = false;
    const removalObserver = new MutationObserver(() => {
      if (removalCheckQueued) return;
      removalCheckQueued = true;
      queueMicrotask(() => {
        removalCheckQueued = false;
        for (const st of [...states.values()]) {
          if (!st.img.isConnected) handleRemoved(st);
        }
      });
    });
    removalObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ---------------------------------------------------------------------
    // Background → content messages (§7.1 BgResponse + consent handshake)
    // ---------------------------------------------------------------------

    function onProgress(event: ProgressEvent): void {
      const st = byId.get(event.imageId);
      if (!st) return;
      if (!st.img.isConnected) {
        handleRemoved(st);
        return;
      }
      if (event.stage === 'download') {
        showBadge(st, BADGE_DOWNLOADING, 'progress');
        return;
      }
      if (event.stage === 'done') {
        // §6.5: partial success keeps the image and shows 'Untranslated: N line(s)';
        // §6.1: a clean run shows 'done' and fades after 2 s.
        if (event.detail) showBadge(st, event.detail, 'untranslated');
        else {
          showBadge(st, BADGE_DONE, 'done');
          scheduleFade(st);
        }
        return;
      }
      if (event.stage === 'error') return; // failures arrive via 'result'
      const label = STAGE_LABEL[event.stage] ?? event.stage;
      showBadge(
        st,
        `${label} ${event.done}/${event.total}${event.detail ? ` · ${event.detail}` : ''}`,
        'progress',
      );
    }

    function onImageBlob(msg: Extract<BgResponse, { kind: 'imageBlob' }>): void {
      const st = byId.get(msg.imageId);
      if (!st) return;
      if (!st.img.isConnected) {
        handleRemoved(st);
        return;
      }
      const blob = new Blob([base64ToBytes(msg.pngB64).buffer as ArrayBuffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob); // same-origin blob URL (§6.2)
      if (st.blobUrl) URL.revokeObjectURL(st.blobUrl);
      st.blobUrl = url;
      st.img.src = url;
      if (st.status === 'running') st.status = 'translated';
      positionBadge(st);
    }

    function onResult(msg: Extract<BgResponse, { kind: 'result' }>): void {
      const st = byId.get(msg.imageId);
      if (!st) return;
      if (msg.ok) {
        // Nothing committed (all tags missing) → image untouched, allow retry.
        if (st.status === 'running' && !st.blobUrl) st.status = 'idle';
        return; // the 'done' progress event already surfaced the outcome
      }
      // Hard failure: revert to the original attributes (partial composites are
      // discarded) and show the exact error string.
      if (st.status === 'translated') {
        restoreAttributes(st);
        void sendBg({ kind: 'restore', imageId: st.id } satisfies BgRequest).catch(() => undefined);
      }
      st.status = 'idle';
      st.saved = null;
      if (st.blobUrl) {
        URL.revokeObjectURL(st.blobUrl);
        st.blobUrl = null;
      }
      st.retryable = msg.error === BADGE_FAILED;
      showBadge(st, msg.error, 'error', st.retryable);
    }

    // ---------------------------------------------------------------------
    // Overlay badge (§4 overlay badge; §6.1 progress / done / errors)
    // ---------------------------------------------------------------------

    const BADGE_CSS = `
.mpt-badge {
  position: absolute;
  z-index: 2147483647;
  transform: translate(-100%, -2px);
  max-width: 340px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(20, 20, 20, 0.85);
  color: #fff;
  font: 12px/1.4 system-ui, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.4s ease;
}
.mpt-badge.mpt-clickable { pointer-events: auto; cursor: pointer; }
.mpt-badge.mpt-error { background: rgba(140, 24, 24, 0.92); }
.mpt-badge.mpt-faded { opacity: 0; }
.mpt-consent { border: 1px solid #999; border-radius: 8px; padding: 16px; max-width: 420px;
  font: 13px/1.5 system-ui, sans-serif; }
.mpt-consent h2 { font-size: 15px; margin: 0 0 8px; }
.mpt-consent ul { margin: 8px 0; padding-left: 18px; }
.mpt-consent .mpt-row { margin: 10px 0 0; display: flex; gap: 8px; justify-content: flex-end; }
.mpt-consent button { padding: 4px 14px; }
`;

    let styleEl: HTMLStyleElement | null = null;

    function ensureStyle(): void {
      if (styleEl && styleEl.isConnected) return;
      styleEl = document.createElement('style');
      styleEl.textContent = BADGE_CSS;
      (document.head ?? document.documentElement).appendChild(styleEl);
    }

    function badgeFor(st: ImageState): HTMLDivElement {
      if (!st.badge || !st.badge.isConnected) {
        ensureStyle();
        const badge = document.createElement('div');
        badge.className = 'mpt-badge';
        badge.onclick = () => {
          if (st.badgeMode === 'restoreOffer') restoreImage(st.img);
          else if (st.badgeMode === 'error' && st.retryable) triggerTranslate(st.img);
        };
        (document.body ?? document.documentElement).appendChild(badge);
        st.badge = badge;
      }
      return st.badge;
    }

    function showBadge(st: ImageState, text: string, mode: ImageState['badgeMode'], clickable = false): void {
      const badge = badgeFor(st);
      st.badgeMode = mode;
      badge.textContent = text;
      badge.classList.toggle('mpt-clickable', clickable);
      badge.classList.toggle('mpt-error', mode === 'error');
      badge.classList.remove('mpt-faded');
      if (st.fadeTimer !== null) {
        clearTimeout(st.fadeTimer);
        st.fadeTimer = null;
      }
      positionBadge(st);
    }

    /** §6.1: the badge fades after 2 s on success (the element stays for the hover toggle). */
    function scheduleFade(st: ImageState): void {
      if (st.fadeTimer !== null) clearTimeout(st.fadeTimer);
      st.fadeTimer = setTimeout(() => {
        st.fadeTimer = null;
        st.badge?.classList.add('mpt-faded');
      }, 2000);
    }

    function hideBadge(st: ImageState): void {
      if (st.fadeTimer !== null) {
        clearTimeout(st.fadeTimer);
        st.fadeTimer = null;
      }
      st.badge?.remove();
      st.badge = null;
      st.badgeMode = 'hidden';
    }

    function positionBadge(st: ImageState): void {
      const badge = st.badge;
      if (!badge) return;
      const r = st.img.getBoundingClientRect();
      badge.style.left = `${Math.round(window.scrollX + r.right)}px`;
      badge.style.top = `${Math.round(window.scrollY + r.top)}px`;
    }

    /** AC2 overlay toggle: hovering a translated image offers the restore click. */
    function wireHoverToggle(st: ImageState): void {
      st.img.addEventListener('mouseenter', () => {
        if (st.status === 'translated' && st.badgeMode === 'done') {
          showBadge(st, RESTORE_LABEL, 'restoreOffer', true);
        }
      });
      st.img.addEventListener('mouseleave', () => {
        if (st.badgeMode === 'restoreOffer') {
          st.badge?.classList.add('mpt-faded');
          st.badgeMode = 'done';
        }
      });
    }

    // ---------------------------------------------------------------------
    // AC7 consent dialog (before any uncached model is fetched)
    // ---------------------------------------------------------------------

    function handleConsent(msg: ConsentRequest): void {
      const st = byId.get(msg.imageId);
      if (!st || st.status !== 'running' || !st.img.isConnected) {
        void sendBg({ kind: 'consentResult', imageId: msg.imageId, approved: false }).catch(
          () => undefined,
        );
        return;
      }
      const dialog = document.createElement('dialog');
      dialog.className = 'mpt-consent';
      const title = document.createElement('h2');
      title.textContent = 'Download models';
      const text = document.createElement('p');
      text.textContent = 'Models needed for translation are not cached yet. They download once and are stored locally in this browser.';
      const list = document.createElement('ul');
      for (const file of msg.files) {
        const li = document.createElement('li');
        li.textContent = `${file.name} — ${formatExact(file.bytes)}`;
        list.appendChild(li);
      }
      const row = document.createElement('div');
      row.className = 'mpt-row';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      const download = document.createElement('button');
      download.textContent = 'Download';
      row.append(cancel, download);
      dialog.append(title, text, list, row);

      let decided = false;
      const decide = (approved: boolean): void => {
        if (decided) return;
        decided = true;
        dialog.close();
        const current = byId.get(msg.imageId);
        if (!current) {
          // Image removed while the dialog was open — answer so the job ends.
          void sendBg({ kind: 'consentResult', imageId: msg.imageId, approved: false }).catch(
            () => undefined,
          );
          return;
        }
        if (!approved) {
          // Cancelled consent: nothing was (or will be) fetched (AC7); revert
          // the trigger so the image can be retried later.
          current.status = 'idle';
          restoreAttributes(current);
          current.saved = null;
          current.originalSrcUrl = null;
          hideBadge(current);
        }
        void sendBg({ kind: 'consentResult', imageId: msg.imageId, approved }).catch(
          () => undefined,
        );
      };
      download.onclick = () => decide(true);
      cancel.onclick = () => decide(false);
      dialog.addEventListener('cancel', () => decide(false));
      (document.body ?? document.documentElement).append(dialog);
      try {
        dialog.showModal();
      } catch {
        dialog.show(); // another dialog is already modal
      }
    }

    function formatExact(bytes: number): string {
      if (bytes >= 1024 * 1024) return `${bytes.toLocaleString('en-US')} bytes (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
      if (bytes >= 1024) return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1024).toFixed(1)} KB)`;
      return `${bytes.toLocaleString('en-US')} bytes`;
    }

    // ---------------------------------------------------------------------
    // Image targeting (§6.1) + per-site srcLang (A6)
    // ---------------------------------------------------------------------

    function visibleArea(img: HTMLImageElement): number {
      const r = img.getBoundingClientRect();
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      return w > 0 && h > 0 ? w * h : 0;
    }

    /** Toolbar action: the largest <img> by visible area in the viewport (§6.1). */
    function largestVisibleImage(): HTMLImageElement | null {
      let best: HTMLImageElement | null = null;
      let bestArea = 0;
      for (const img of document.images) {
        if (!img.isConnected || !img.complete || img.naturalWidth === 0) continue;
        const area = visibleArea(img);
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      }
      return best;
    }

    function findImageBySrc(srcUrl: string, translatedOnly: boolean): HTMLImageElement | null {
      const matches: HTMLImageElement[] = [];
      for (const img of document.images) {
        const st = states.get(img);
        const urlMatch = (st !== undefined && st.originalSrcUrl === srcUrl) || img.currentSrc === srcUrl || img.src === srcUrl;
        if (!urlMatch) continue;
        if (translatedOnly && (st === undefined || st.status !== 'translated')) continue;
        matches.push(img);
      }
      let best: HTMLImageElement | null = null;
      let bestArea = 0;
      for (const img of matches) {
        const area = visibleArea(img);
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      }
      return best ?? matches[0] ?? null;
    }

    async function effectiveSrcLang(): Promise<SrcLang> {
      const settings = await loadSettings();
      const stored = await browser.storage.local.get(PER_SITE_KEY);
      const map = stored[PER_SITE_KEY] as Record<string, SrcLang> | undefined;
      return map?.[location.hostname] ?? settings.srcLang;
    }

    async function siteInfo(): Promise<ContentResponse> {
      return { kind: 'siteInfo', hostname: location.hostname, srcLang: await effectiveSrcLang() };
    }

    /** Popup quick selector: remember per site (A6) and set the global default. */
    async function setSrcLang(srcLang: SrcLang): Promise<void> {
      const stored = await browser.storage.local.get(PER_SITE_KEY);
      const map = { ...((stored[PER_SITE_KEY] as Record<string, SrcLang> | undefined) ?? {}) };
      map[location.hostname] = srcLang;
      await browser.storage.local.set({ [PER_SITE_KEY]: map });
      await saveSettings({ ...(await loadSettings()), srcLang });
    }

    // ---------------------------------------------------------------------
    // Message router
    // ---------------------------------------------------------------------

    browser.runtime.onMessage.addListener(
      (
        raw: unknown,
        _sender: Browser.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ): boolean | undefined => {
        const msg = raw as { kind?: string; srcUrl?: string; srcLang?: string; event?: ProgressEvent } | null | undefined;
        if (!msg || typeof msg.kind !== 'string') return undefined;
        if (msg.kind === 'progress') {
          if (msg.event) onProgress(msg.event);
        } else if (msg.kind === 'imageBlob') {
          onImageBlob(msg as unknown as Extract<BgResponse, { kind: 'imageBlob' }>);
        } else if (msg.kind === 'result') {
          onResult(msg as unknown as Extract<BgResponse, { kind: 'result' }>);
        } else if (msg.kind === 'consentRequest') {
          handleConsent(msg as unknown as ConsentRequest);
        } else if (msg.kind === 'actionTranslate') {
          const img = largestVisibleImage();
          if (img) triggerTranslate(img);
          sendResponse({ kind: 'actionResult', found: img !== null } satisfies ContentResponse);
        } else if (msg.kind === 'menuTranslate') {
          const img = findImageBySrc(String(msg.srcUrl ?? ''), false);
          if (img) triggerTranslate(img);
        } else if (msg.kind === 'menuRestore') {
          const img = findImageBySrc(String(msg.srcUrl ?? ''), true);
          if (img) restoreImage(img);
        } else if (msg.kind === 'getSiteInfo') {
          void siteInfo().then(
            (reply) => sendResponse(reply),
            async () => {
              // storage unavailable — report the global default
              const fallback = await loadSettings().catch(() => null);
              sendResponse({
                kind: 'siteInfo',
                hostname: location.hostname,
                srcLang: fallback?.srcLang ?? 'ja',
              });
            },
          );
          return true; // async sendResponse
        } else if (msg.kind === 'setSrcLang') {
          const lang = msg.srcLang;
          if (lang === 'ja' || lang === 'ko' || lang === 'zh') void setSrcLang(lang);
        }
        return undefined;
      },
    );
  },
});

/** PNG bytes from the background's base64-encoded composite. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
