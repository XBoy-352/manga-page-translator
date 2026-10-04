// `remote` backend: OpenAI-compatible POST {remoteUrl}/chat/completions with
// SSE streaming (SPEC §7.6 / §6.4).

import type { Settings } from '../../shared/types';
import type { GlossaryEntry } from './prompt';
import {
  LineParser,
  runTranslate,
  type ChatMessage,
  type LineHandler,
  type TranslateBackend,
} from './backend';

const TIMEOUT_MS = 30_000; // SPEC §6.5: no response within 30 s → abort

export class RemoteBackend implements TranslateBackend {
  readonly kind = 'remote' as const;

  constructor(private readonly settings: Settings) {}

  translate(
    req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
    onLine: LineHandler,
  ): Promise<{ totalMs: number; firstMs: number }> {
    return runTranslate(req, (messages, emit) => this.streamOnce(messages, emit), onLine);
  }

  private async streamOnce(messages: ChatMessage[], onLine: LineHandler): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Rearmed on every received chunk: the 30 s rule is "no response within
    // 30 s" — a stream that is actively producing is responding, so the abort
    // only fires when the endpoint never answers or goes silent (§6.5).
    const armTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    };
    armTimeout();
    try {
      let response: Response;
      try {
        response = await fetch(this.settings.remoteUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // A11: only sent when the user configured a key (401/403 map to
            // 'Backend unreachable (check URL and API key)' upstream).
            ...(this.settings.remoteApiKey
              ? { Authorization: `Bearer ${this.settings.remoteApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.settings.remoteModel,
            temperature: 0,
            stream: true,
            max_tokens: 512,
            chat_template_kwargs: { enable_thinking: false },
            messages,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error('Backend unreachable', { cause: err });
      }
      if (!response.ok || !response.body) {
        throw new Error('Backend unreachable', { cause: new Error(`HTTP ${response.status}`) });
      }
      try {
        await this.consumeSse(response.body, onLine, armTimeout);
      } catch (err) {
        // Mid-stream failure: network drop or the 30 s idle abort (§6.5).
        throw new Error('Backend unreachable', { cause: err });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parses `data: {json}` SSE lines and feeds delta text to the line parser. */
  private async consumeSse(
    body: ReadableStream<Uint8Array>,
    onLine: LineHandler,
    armTimeout: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new LineParser(onLine);
    let events = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimeout();
      events += decoder.decode(value, { stream: true });
      let nl = events.indexOf('\n');
      while (nl !== -1) {
        let line = events.slice(0, nl);
        events = events.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const event = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = event.choices?.[0]?.delta?.content;
            if (content) parser.push(content);
          } catch {
            // Malformed SSE JSON line — tolerate and keep streaming.
          }
        }
        nl = events.indexOf('\n');
      }
    }
    decoder.decode(); // flush multi-byte tail; a trailing partial SSE line is ignored
  }
}
