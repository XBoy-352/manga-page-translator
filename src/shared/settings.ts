import { browser } from 'wxt/browser';
import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  srcLang: 'ja',
  tgtLang: 'en',
  backend: 'local',
  remoteUrl: '',
  remoteModel: 'qwen2.5-1.5b',
  inpaint: 'telea',
  lite: false,
  sfxThreshold: 0.5,
  glossary: [],
};

// assumption taken -- SPEC §7.1 does not name the storage key; the whole
// Settings object is stored under a single 'settings' key in the sync area.
const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.sync.set({ [SETTINGS_KEY]: settings });
}
