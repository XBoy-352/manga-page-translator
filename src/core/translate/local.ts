// `local` backend: Qwen2.5-1.5B-Instruct via Transformers.js inside a
// dedicated worker (SPEC §7.6). All generation happens in
// src/worker/llm.worker.ts; this class shuttles messages and owns the
// shared retry/timing driver. The worker is kept alive across translations
// so the weights stay warm; it is discarded on failure so the next
// translate() spawns a fresh one.

import { runTranslate, type ChatMessage, type LineHandler, type TranslateBackend } from './backend';
import type { GlossaryEntry } from './prompt';
import type { LlmWorkerIn, LlmWorkerOut } from '../../worker/llm.worker';

export class LocalBackend implements TranslateBackend {
  readonly kind = 'local' as const;

  private worker: Worker | null = null;

  translate(
    req: { strings: string[]; glossary: GlossaryEntry[]; previous: string[] },
    onLine: LineHandler,
  ): Promise<{ totalMs: number; firstMs: number }> {
    const worker = this.ensureWorker();
    return runTranslate(req, (messages, emit) => this.generate(worker, messages, emit), onLine);
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      // Vite bundles this URL into a module worker chunk.
      this.worker = new Worker(new URL('../../worker/llm.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return this.worker;
  }

  /** One generation pass; resolves on 'done', rejects on 'error'. */
  private generate(worker: Worker, messages: ChatMessage[], emit: LineHandler): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<LlmWorkerOut>) => {
        const msg = event.data;
        if (msg.type === 'line') emit(msg.tag, msg.text);
        else if (msg.type === 'done') resolve();
        else this.fail(worker, reject, msg.message);
      };
      worker.onerror = (event: ErrorEvent) => {
        this.fail(worker, reject, event.message || 'LLM worker failed');
      };
      const request: LlmWorkerIn = { type: 'translate', messages };
      worker.postMessage(request);
    });
  }

  /** Drops the (possibly wedged) worker so the next call spawns a fresh one. */
  private fail(worker: Worker, reject: (err: Error) => void, message: string): void {
    if (this.worker === worker) this.worker = null;
    worker.terminate();
    reject(new Error(message));
  }
}
