import { browser } from 'wxt/browser';

const versionEl = document.querySelector('#version');
if (versionEl) {
  versionEl.textContent = `Version ${browser.runtime.getManifest().version}`;
}
