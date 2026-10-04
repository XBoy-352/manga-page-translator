import { describe, expect, it } from 'vitest';
import { buildSystemMessage, buildUserMessage, type GlossaryEntry } from '../src/core/translate/prompt';

// Byte-exact strings from SPEC §6.4.
const SYSTEM =
  "You translate comic dialogue to English. Keep each line short and natural. Preserve names exactly as written in the GLOSSARY. Keep the speaker's tone (casual, formal, shouting). Do not explain, annotate, or add quotes. Reply with exactly one line per input tag, in the same order, formatted 'N: translation'.";

describe('buildSystemMessage', () => {
  it('returns the §6.4 system string byte-exact', () => {
    expect(buildSystemMessage()).toBe(SYSTEM);
  });
});

describe('buildUserMessage', () => {
  it('reproduces the §6.4 normative example byte-exact', () => {
    expect(
      buildUserMessage({
        strings: ['待て!', '許さんぞ…'],
        glossary: [
          { src: '先輩', dst: 'Senpai' },
          { src: '殿下', dst: 'Your Highness' },
        ],
        previous: ['We need to leave now.'],
      }),
    ).toBe(
      'GLOSSARY\n' +
        '先輩=Senpai\n' +
        '殿下=Your Highness\n' +
        'CONTEXT (previous page)\n' +
        '1: We need to leave now.\n' +
        'TRANSLATE\n' +
        '1: 待て!\n' +
        '2: 許さんぞ…',
    );
  });

  it('omits the CONTEXT block on the first page (no previous)', () => {
    const out = buildUserMessage({
      strings: ['待て!'],
      glossary: [{ src: '先輩', dst: 'Senpai' }],
      previous: [],
    });
    expect(out).toBe('GLOSSARY\n先輩=Senpai\nTRANSLATE\n1: 待て!');
    expect(out).not.toContain('CONTEXT');
  });

  it('numbers the TRANSLATE lines 1-based in order', () => {
    const out = buildUserMessage({
      strings: ['a', 'b', 'c'],
      glossary: [{ src: 'x', dst: 'X' }],
      previous: [],
    });
    expect(out).toBe('GLOSSARY\nx=X\nTRANSLATE\n1: a\n2: b\n3: c');
  });

  it('caps the glossary at 50 entries', () => {
    const glossary: GlossaryEntry[] = Array.from({ length: 55 }, (_, i) => ({
      src: `s${i + 1}`,
      dst: `d${i + 1}`,
    }));
    const out = buildUserMessage({ strings: ['x'], glossary, previous: [] });
    const expectedEntries = Array.from({ length: 50 }, (_, i) => `s${i + 1}=d${i + 1}`).join('\n');
    expect(out).toBe(`GLOSSARY\n${expectedEntries}\nTRANSLATE\n1: x`);
    expect(out).not.toContain('s51');
  });

  it('keeps only the last 12 previous strings, renumbered 1..12', () => {
    const previous = Array.from({ length: 15 }, (_, i) => `line-${i + 1}`);
    const out = buildUserMessage({
      strings: ['x'],
      glossary: [],
      previous,
    });
    const kept = Array.from({ length: 12 }, (_, i) => `${i + 1}: line-${i + 4}`).join('\n');
    expect(out).toBe(`GLOSSARY\n\nCONTEXT (previous page)\n${kept}\nTRANSLATE\n1: x`);
    expect(out).not.toContain('line-3\n');
  });

  it('truncates previous strings to 60 chars', () => {
    const out = buildUserMessage({
      strings: [],
      glossary: [],
      previous: ['x'.repeat(80)],
    });
    expect(out).toBe(`GLOSSARY\n\nCONTEXT (previous page)\n1: ${'x'.repeat(60)}\nTRANSLATE\n`);
    expect(out).not.toContain('x'.repeat(61));
  });

  it('keeps a previous string of exactly 60 chars intact', () => {
    const exact = 'y'.repeat(60);
    const out = buildUserMessage({ strings: [], glossary: [], previous: [exact] });
    expect(out).toContain(`1: ${exact}\n`);
  });

  it('empty glossary leaves the literal "GLOSSARY\\n" + "\\nTRANSLATE" from the formula (one blank line)', () => {
    // The binding formula is a literal concatenation; with zero glossary
    // entries the two separators meet and yield exactly one blank line.
    const out = buildUserMessage({ strings: ['x'], glossary: [], previous: [] });
    expect(out).toBe('GLOSSARY\n\nTRANSLATE\n1: x');
  });
});
