// Message surface for slice s9 (content ⇄ background ⇄ popup).
//
// §7.1 defines BgRequest / BgResponse / ProgressEvent in shared/types.ts and
// those declarations stay verbatim there; this module re-exports them and adds
// the wire types the s9 shell needs (tab-directed requests, the AC7 consent
// handshake, and the popup status query). "Extend only": nothing §7.1 fixes is
// redefined except BgResponse's imageBlob variant, which gains one optional
// transport field (see the comment below).

import type { BackendKind, ProgressEvent, SrcLang, Timings } from './types';

export type { BgRequest, ProgressEvent } from './types';

/**
 * §7.1 BgResponse with one s9 extension: Chromium extension messaging
 * JSON-serializes messages, so a raw ArrayBuffer cannot cross
 * tabs.sendMessage. The streaming composite therefore also travels as
 * base64-encoded PNG in `pngB64` (the shape the sender always provides);
 * `buf` stays in the type (optional) for structured-clone targets per §7.1.
 * Content scripts render pngB64 into a same-origin blob URL (§6.2).
 */
export type BgResponse =
  | { kind: 'progress'; event: ProgressEvent }
  | { kind: 'result'; imageId: string; ok: true; width: number; height: number; timings: Timings }
  | { kind: 'result'; imageId: string; ok: false; error: string }
  | { kind: 'imageBlob'; imageId: string; buf?: ArrayBuffer; width: number; height: number; pngB64: string };

// ---------------------------------------------------------------------------
// Tab-directed requests (toolbar action, context menus, popup → content)
// ---------------------------------------------------------------------------

export type ContentRequest =
  /** Toolbar action / popup button: translate the largest visible <img>. */
  | { kind: 'actionTranslate' }
  /** Context menu 'Translate image' — targets an <img> showing srcUrl. */
  | { kind: 'menuTranslate'; srcUrl: string }
  /** Context menu 'Restore original image' — targets an <img> showing srcUrl. */
  | { kind: 'menuRestore'; srcUrl: string }
  /** Popup: hostname + effective srcLang of the page (A6 per-site memory). */
  | { kind: 'getSiteInfo' }
  /** Popup srcLang quick selector: remember for this site + as the default. */
  | { kind: 'setSrcLang'; srcLang: SrcLang };

export type ContentResponse =
  | { kind: 'actionResult'; found: boolean }
  | { kind: 'siteInfo'; hostname: string; srcLang: SrcLang };

// ---------------------------------------------------------------------------
// AC7 download consent (background ⇄ content handshake)
// ---------------------------------------------------------------------------

/** background → content: ask before fetching any model file that is not cached. */
export type ConsentRequest = {
  kind: 'consentRequest';
  imageId: string;
  files: { id: string; name: string; bytes: number }[];
};

/**
 * content → background: the user's consent answer. Declared beside §7.1's
 * BgRequest (not inside it) so the normative two-kind union stays untouched.
 */
export type ConsentResult = { kind: 'consentResult'; imageId: string; approved: boolean };

// ---------------------------------------------------------------------------
// popup ⇄ background
// ---------------------------------------------------------------------------

export type PopupRequest = { kind: 'getStatus' };

export type PopupResponse = {
  kind: 'status';
  backend: BackendKind;
  remoteUrl: string;
  /** Exact §4/§6.5 string of the last failed job, if any ('Backend unreachable', …). */
  lastError: string | null;
};
