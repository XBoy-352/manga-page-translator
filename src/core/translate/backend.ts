// Core translation contracts shared by all three backends (SPEC §7.6): the
// `TranslateBackend` interface, the streaming 'N: text' line parser, the
// one-retry driver, and `createBackend`.

import type { BackendKind, Settings } from '../../shared/types';
import { buildSystemMessage, buildUserMessage, type GlossaryEntry } from './prompt';
// The impls import this module (LineParser / runTranslate), which makes these
// imports circular; that is benign in ESM because the impl classes are only
// referenced inside createBackend, never at module-evaluation time.
import { LocalBackend } from './local';
import { NanoBackend } from './nano';
import { RemoteBackend } from './remote';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Exactly the SPEC §7.6 interface.
export interface TranslateBackend {
  kind: BackendKind;
  translate(
    req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
    onLine: (tag: number, text: string) => void,
  ): Promise<{ totalMs: number; firstMs: number }>;
}

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Streaming line parser (shared by remote SSE, local tokens, nano chunks)
// ---------------------------------------------------------------------------

// Binding line format from slice s8: a committed reply line is 'N: text'.
const TAG_LINE_RE = /^\s*(\d+):\s*(.+)$/;

// A12: think-open / think-close tags (built from escapes so the source
// stays free of raw markup that could confuse tooling).
const THINK_OPEN = '\u003cthink\u003e';
const THINK_CLOSE = '\u003c/think\u003e';

export type LineHandler = (tag: number, text: string) => void;

/**
 * Incremental parser over a token/chunk stream. Only COMPLETED
 * (newline-terminated) lines are matched and emitted; an incomplete trailing
 * line is buffered and never emitted (slice s8 rule). Lines that do not match
 * the tag format are tolerated and skipped.
 */
export class LineParser {
  private buffer = '';

  constructor(private readonly onLine: LineHandler) {}

  push(chunk: string): void {
    this.buffer += chunk;
    // A12: discard think spans before line matching - reasoning must not
    // leak into the 'N: text' format. Streaming-safe:
    //   1) closed spans are removed wherever they appear;
    //   2) an unclosed think-open tag parks its region until the closer
    //      arrives, while complete lines BEFORE the tag still emit.
    for (;;) {
      const open = this.buffer.indexOf(THINK_OPEN);
      if (open === -1) break;
      const close = this.buffer.indexOf(THINK_CLOSE, open + THINK_OPEN.length);
      if (close === -1) break;
      this.buffer = this.buffer.slice(0, open) + this.buffer.slice(close + THINK_CLOSE.length);
    }
    let held = '';
    const open = this.buffer.indexOf(THINK_OPEN);
    if (open !== -1) {
      held = this.buffer.slice(open);
      this.buffer = this.buffer.slice(0, open);
    }
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const match = TAG_LINE_RE.exec(line);
      if (match) this.onLine(Number(match[1]), match[2]);
      nl = this.buffer.indexOf('\n');
    }
    if (held) this.buffer += held;
  }
}

// ---------------------------------------------------------------------------
// Shared translate driver: prompt messages, timing, one retry (SPEC §6.4)
// ---------------------------------------------------------------------------

// Exact retry string from SPEC §6.4.
export function buildRetryMessage(missing: number[]): string {
  return `Reply again. You missed tag(s): ${missing.join(', ')}. One line per tag.`;
}

/**
 * Streams one translation pass, then — if any tag never committed — retries
 * exactly once with the extra user message from SPEC §6.4. Duplicate tag
 * commits are deduped (first commit wins, so a bubble is never retranslated).
 * `streamOnce` sends one chat conversation and must call `onLine` per
 * committed line.
 */
export async function runTranslate(
  req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
  streamOnce: (messages: ChatMessage[], onLine: LineHandler) => Promise<void>,
  onLine: LineHandler,
): Promise<{ totalMs: number; firstMs: number }> {
  const start = performance.now();
  let firstMs = 0;
  let sawFirst = false;
  const committed = new Set<number>();
  const emit: LineHandler = (tag, text) => {
    if (!sawFirst) {
      sawFirst = true;
      firstMs = performance.now() - start;
    }
    if (!committed.has(tag)) {
      committed.add(tag);
      onLine(tag, text);
    }
  };

  const base: ChatMessage[] = [
    { role: 'system', content: buildSystemMessage() },
    { role: 'user', content: buildUserMessage(req) },
  ];
  await streamOnce(base, emit);

  const missing = req.strings.map((_, i) => i + 1).filter((tag) => !committed.has(tag));
  if (missing.length > 0) {
    await streamOnce([...base, { role: 'user', content: buildRetryMessage(missing) }], emit);
  }

  return { totalMs: performance.now() - start, firstMs };
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

export function createBackend(s: Settings): TranslateBackend {
  // AC9 sync part: without the LanguageModel global nano cannot exist at all.
  if (s.backend === 'nano' && !('LanguageModel' in self)) {
    throw new BackendUnavailableError('Chrome Nano unavailable');
  }
  switch (s.backend) {
    case 'remote':
      return new RemoteBackend(s);
    case 'local':
      // The local model repo/dtype are fixed by SPEC §7.6; no settings needed.
      return new LocalBackend();
    case 'nano':
      // LanguageModel exists here, but availability() is async, so the
      // availability half of the AC9 guard throws from translate()
      // (BackendUnavailableError) and nanoAvailable() serves the settings UI.
      return new NanoBackend();
  }
}
