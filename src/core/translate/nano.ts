// `nano` backend: Chrome built-in Prompt API (`LanguageModel`), SPEC §7.6 /
// AC9. Usable only when `"LanguageModel" in self` AND
// `(await LanguageModel.availability()) === 'available'`; otherwise callers
// get BackendUnavailableError('Chrome Nano unavailable'). Runs wherever the
// background runs (window or service worker) — only `self` is assumed.

import {
  BackendUnavailableError,
  LineParser,
  runTranslate,
  type LineHandler,
  type TranslateBackend,
} from './backend';
import { buildSystemMessage, type GlossaryEntry } from './prompt';

interface NanoCreateOptions {
  temperature?: number;
  initialPrompts?: { role: string; content: string }[];
}

interface NanoSession {
  promptStreaming(text: string): unknown;
  destroy?(): void;
}

interface LanguageModelStatic {
  availability(): Promise<string>;
  create(options?: NanoCreateOptions): Promise<NanoSession>;
}

function languageModel(): LanguageModelStatic | undefined {
  return (self as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

/**
 * AC9 guard for the settings UI: the `nano` option may be offered only when
 * the Prompt API is present and fully available.
 */
export async function nanoAvailable(): Promise<boolean> {
  const lm = languageModel();
  if (!lm || typeof lm.availability !== 'function') return false;
  try {
    return (await lm.availability()) === 'available';
  } catch {
    return false;
  }
}

async function streamSession(session: NanoSession, prompt: string, onLine: LineHandler): Promise<void> {
  const parser = new LineParser(onLine);
  const stream: unknown = session.promptStreaming(prompt);
  const readerLike = stream as {
    getReader?: () => { read(): Promise<{ done: boolean; value?: string }> };
  };
  if (typeof readerLike.getReader === 'function') {
    // Current Prompt API shape: ReadableStream<string>.
    const reader = readerLike.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(value);
    }
  } else {
    // Earlier origin-trial shape: async iterable of string chunks.
    for await (const chunk of stream as AsyncIterable<string>) parser.push(chunk);
  }
}

export class NanoBackend implements TranslateBackend {
  readonly kind = 'nano' as const;

  async translate(
    req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
    onLine: LineHandler,
  ): Promise<{ totalMs: number; firstMs: number }> {
    // AC9 async half: availability() can only be awaited here. createBackend
    // already threw synchronously when "LanguageModel" was absent entirely.
    if (!(await nanoAvailable())) {
      throw new BackendUnavailableError('Chrome Nano unavailable');
    }
    const lm = languageModel();
    if (!lm) throw new BackendUnavailableError('Chrome Nano unavailable');
    // The system string rides in initialPrompts; each streamOnce call sends
    // the last user message, so the retry continues the same conversation.
    const session = await lm.create({
      temperature: 0,
      initialPrompts: [{ role: 'system', content: buildSystemMessage() }],
    });
    try {
      return await runTranslate(
        req,
        async (messages, emit) => {
          const last = messages[messages.length - 1];
          await streamSession(session, last.content, emit);
        },
        onLine,
      );
    } finally {
      session.destroy?.();
    }
  }
}
