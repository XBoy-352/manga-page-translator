import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

describe('DEFAULT_SETTINGS', () => {
  it('matches the spec §7.1 defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      srcLang: 'ja',
      tgtLang: 'en',
      backend: 'local',
      remoteUrl: '',
      remoteApiKey: '',
    remoteModel: 'qwen3.5-0.8b',
      inpaint: 'telea',
      lite: false,
      sfxThreshold: 0.5,
      glossary: [],
    });
  });
});
