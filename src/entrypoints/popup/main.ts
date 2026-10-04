// Popup (slice s9): srcLang quick selector (ja/ko/zh), backend status line,
// translate-visible-image button, and a link to the options page.

import { browser } from 'wxt/browser';
import type {
  ContentRequest,
  ContentResponse,
  PopupRequest,
  PopupResponse,
} from '../../shared/messages';
import type { SrcLang } from '../../shared/types';

const versionEl = document.querySelector('#version');
const statusEl = document.querySelector('#backend-status');
const errorEl = document.querySelector('#backend-error');
const hostEl = document.querySelector('#site-host');
const langBox = document.querySelector<HTMLDivElement>('#src-lang');
const translateBtn = document.querySelector<HTMLButtonElement>('#translate-btn');
const messageEl = document.querySelector('#message');
const optionsLink = document.querySelector<HTMLAnchorElement>('#options-link');

if (versionEl) versionEl.textContent = `Version ${browser.runtime.getManifest().version}`;

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function refreshStatus(): Promise<void> {
  if (!statusEl || !errorEl) return;
  try {
    const reply = (await browser.runtime.sendMessage({
      kind: 'getStatus',
    } satisfies PopupRequest)) as PopupResponse | undefined;
    if (!reply || reply.kind !== 'status') return;
    let text = `Backend: ${reply.backend}`;
    if (reply.backend === 'remote' && reply.remoteUrl) text += ` — ${reply.remoteUrl}`;
    statusEl.textContent = text;
    // §6.5: the popup shows the same failure string with the URL.
    errorEl.textContent =
      reply.lastError && reply.lastError !== '' && reply.remoteUrl && !text.includes(reply.remoteUrl)
        ? `${reply.lastError} — ${reply.remoteUrl}`
        : (reply.lastError ?? '');
  } catch {
    statusEl.textContent = 'Backend: unavailable'; // background not reachable
  }
}

function markActive(lang: SrcLang): void {
  if (!langBox) return;
  for (const button of langBox.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.lang === lang);
    button.disabled = false;
  }
}

function setLangButtons(enabled: boolean): void {
  if (!langBox) return;
  for (const button of langBox.querySelectorAll('button')) button.disabled = !enabled;
}

async function refreshSite(): Promise<void> {
  if (!hostEl) return;
  const tabId = await activeTabId();
  if (tabId === undefined) {
    setLangButtons(false);
    return;
  }
  try {
    const reply = (await browser.tabs.sendMessage(tabId, {
      kind: 'getSiteInfo',
    } satisfies ContentRequest)) as ContentResponse | undefined;
    if (reply && reply.kind === 'siteInfo') {
      hostEl.textContent = reply.hostname ? reply.hostname : 'this page';
      markActive(reply.srcLang);
      return;
    }
  } catch {
    // No content script on this page (browser UI, unsupported scheme…).
  }
  hostEl.textContent = 'Not available on this page';
  setLangButtons(false);
}

async function onPickLang(lang: SrcLang): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, {
      kind: 'setSrcLang',
      srcLang: lang,
    } satisfies ContentRequest);
    markActive(lang);
  } catch {
    // content script unreachable — selection stays unchanged
  }
}

async function onTranslate(): Promise<void> {
  if (!messageEl) return;
  messageEl.textContent = '';
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  try {
    const reply = (await browser.tabs.sendMessage(tabId, {
      kind: 'actionTranslate',
    } satisfies ContentRequest)) as ContentResponse | undefined;
    if (!reply || reply.kind !== 'actionResult' || !reply.found) messageEl.textContent = 'No image found';
  } catch {
    messageEl.textContent = 'No image found';
  }
}

if (langBox) {
  for (const button of langBox.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const lang = button.dataset.lang;
      if (lang === 'ja' || lang === 'ko' || lang === 'zh') void onPickLang(lang);
    });
  }
}
translateBtn?.addEventListener('click', () => void onTranslate());
optionsLink?.addEventListener('click', (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
});

setLangButtons(false);
void refreshStatus();
void refreshSite();
