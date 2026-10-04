import { describe, expect, it } from 'vitest';
import {
  BackendUnavailableError,
  LineParser,
  buildRetryMessage,
  createBackend,
  runTranslate,
  type ChatMessage,
  type LineHandler,
} from '../src/core/translate/backend';
import type { BackendKind, Settings } from '../src/shared/types';

function collect(): { lines: Array<[number, string]>; push(chunk: string): void } {
  const lines: Array<[number, string]> = [];
  const parser = new LineParser((tag, text) => lines.push([tag, text]));
  return { lines, push: (chunk) => parser.push(chunk) };
}

describe('LineParser', () => {
  it('emits every completed (newline-terminated) "N: text" line', () => {
    const { lines, push } = collect();
    push('1: Hello\n2: World\n');
    expect(lines).toEqual([
      [1, 'Hello'],
      [2, 'World'],
    ]);
  });

  it('never emits an incomplete trailing line', () => {
    const { lines, push } = collect();
    push('1: Hello');
    expect(lines).toEqual([]);
    push('\n'); // completing the line emits exactly once
    expect(lines).toEqual([[1, 'Hello']]);
  });

  it('reassembles lines split across arbitrary chunks', () => {
    const { lines, push } = collect();
    push('1: He');
    push('llo\n');
    push('2: W');
    push('o');
    push('rld\n');
    expect(lines).toEqual([
      [1, 'Hello'],
      [2, 'World'],
    ]);
  });

  it('tolerates garbage lines (spec prose, echoes, blanks)', () => {
    const { lines, push } = collect();
    push('TRANSLATE\nhello world\n1:\nfoo: bar\n\n42 is a number\n1: real\n');
    expect(lines).toEqual([[1, 'real']]);
  });

  it('matches the binding regex: leading whitespace, multi-digit tags, no trailing trim', () => {
    const { lines, push } = collect();
    push('  12:  hi \n');
    expect(lines).toEqual([[12, 'hi ']]);
  });

  it('emits duplicate tags as parsed (deduping is the driver\u2019s job)', () => {
    const { lines, push } = collect();
    push('1: first\n1: second\n');
    expect(lines).toEqual([
      [1, 'first'],
      [1, 'second'],
    ]);
  });

  it('strips a \\r before matching (CRLF-tolerant)', () => {
    const { lines, push } = collect();
    push('1: Hello\r\n');
    expect(lines).toEqual([[1, 'Hello']]);
  });
});

describe('buildRetryMessage', () => {
  it('is byte-exact per §6.4', () => {
    expect(buildRetryMessage([2, 5])).toBe('Reply again. You missed tag(s): 2, 5. One line per tag.');
  });
});

describe('runTranslate', () => {
  const req = { strings: ['a', 'b', 'c'], glossary: [], previous: [] };

  it('retries exactly once for missing tags with the §6.4 extra user message', async () => {
    const calls: ChatMessage[][] = [];
    const emitted: Array<[number, string]> = [];
    const result = await runTranslate(
      req,
      async (messages, emit) => {
        calls.push(messages);
        if (calls.length === 1) {
          emit(1, 'A'); // tags 2 and 3 missing
        } else {
          emit(2, 'B');
          emit(3, 'C');
        }
      },
      (tag, text) => emitted.push([tag, text]),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      { role: 'system', content: expect.any(String) },
      { role: 'user', content: expect.stringContaining('TRANSLATE') },
    ]);
    expect(calls[1]![2]).toEqual({
      role: 'user',
      content: 'Reply again. You missed tag(s): 2, 3. One line per tag.',
    });
    expect(emitted).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ]);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.firstMs).toBeGreaterThanOrEqual(0);
  });

  it('does not retry when every tag committed', async () => {
    let calls = 0;
    await runTranslate(
      req,
      async (_messages, emit) => {
        calls++;
        emit(1, 'A');
        emit(2, 'B');
        emit(3, 'C');
      },
      () => {},
    );
    expect(calls).toBe(1);
  });

  it('dedupes repeated tags (first commit wins)', async () => {
    const emitted: Array<[number, string]> = [];
    await runTranslate(
      req,
      async (_messages, emit) => {
        emit(1, 'first');
        emit(1, 'second');
        emit(2, 'B');
      },
      (tag, text) => emitted.push([tag, text]),
    );
    expect(emitted).toEqual([
      [1, 'first'],
      [2, 'B'],
    ]);
  });

  it('sends the same system string in both passes', async () => {
    const systems: string[] = [];
    await runTranslate(
      req,
      async (messages) => {
        systems.push(messages[0]!.content);
      },
      () => {},
    );
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe(systems[1]);
  });
});

describe('createBackend', () => {
  function settings(backend: BackendKind): Settings {
    return {
      srcLang: 'ja',
      tgtLang: 'en',
      backend,
      remoteUrl: '',
      remoteModel: 'qwen2.5-1.5b',
      inpaint: 'telea',
      lite: false,
      sfxThreshold: 0.5,
      glossary: [],
    };
  }

  it('returns a remote backend', () => {
    expect(createBackend(settings('remote')).kind).toBe('remote');
  });

  it('returns a local backend', () => {
    expect(createBackend(settings('local')).kind).toBe('local');
  });

  it('throws BackendUnavailableError("Chrome Nano unavailable") when LanguageModel is absent (AC9)', () => {
    // Node test env has no LanguageModel global; the worker shim below keeps
    // `self` defined in environments that lack it.
    if (typeof globalThis.self === 'undefined') {
      (globalThis as Record<string, unknown>).self = globalThis;
    }
    expect(() => createBackend(settings('nano'))).toThrowError(BackendUnavailableError);
    expect(() => createBackend(settings('nano'))).toThrowError('Chrome Nano unavailable');
  });
});

describe('BackendUnavailableError', () => {
  it('is an Error', () => {
    expect(new BackendUnavailableError('x')).toBeInstanceOf(Error);
    expect(new BackendUnavailableError('x').name).toBe('BackendUnavailableError');
  });
});

describe('LineParser think-block stripping (A12)', () => {
  it('discards a completed think block before line matching', () => {
    const { lines, push } = collect();
    push('\u003cthink\u003ereasoning here\u003c/think\u003e\n1: Hello\n');
    expect(lines).toEqual([[1, 'Hello']]);
  });

  it('suppresses a think block held open across chunks, but keeps lines before it', () => {
    const { lines, push } = collect();
    push('1: Hi\n\u003cthink\u003epartial');
    push(' still thinking');
    push('\u003c/think\u003e\n2: Done\n');
    expect(lines).toEqual([
      [1, 'Hi'],
      [2, 'Done'],
    ]);
  });

  it('never emits anything from a think block that never closes', () => {
    const { lines, push } = collect();
    push('1: Before\n\u003cthink\u003enever closed');
    expect(lines).toEqual([[1, 'Before']]);
  });
});
