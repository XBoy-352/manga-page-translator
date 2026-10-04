// LLM worker: Qwen3.5-0.8B via Transformers.js (SPEC §7.6, A12).
// One 'translate' message = one generation pass over the given chat messages
// (the system+user strings come from prompt.ts via the caller). Generated
// tokens stream through the shared LineParser; each COMPLETED 'N: text' line
// is posted back as a 'line' message, followed by 'done' or 'error'.

import { pipeline, TextStreamer } from '@huggingface/transformers';
import type { TextGenerationPipeline } from '@huggingface/transformers';
import { LineParser, type ChatMessage } from '../core/translate/backend';

export interface LlmWorkerIn {
  type: 'translate';
  messages: ChatMessage[];
}

export type LlmWorkerOut =
  | { type: 'line'; tag: number; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// Exact repo / dtype from SPEC §7.6 and §7.9 (LOCAL_LLM).
const MODEL_REPO = 'onnx-community/Qwen3.5-0.8B-Text-ONNX';
const MAX_NEW_TOKENS = 512;

interface WorkerScope {
  onmessage: ((event: MessageEvent<LlmWorkerIn>) => void) | null;
  postMessage(message: LlmWorkerOut): void;
}

const scope = self as unknown as WorkerScope;

let generatorPromise: Promise<TextGenerationPipeline> | null = null;

function getGenerator(): Promise<TextGenerationPipeline> {
  generatorPromise ??= pipeline<'text-generation'>("text-generation", MODEL_REPO, {
    dtype: 'q4',
    // WebGPU when the runtime offers it, never required (SPEC §9).
    device: (navigator as Navigator & { gpu?: unknown }).gpu ? 'webgpu' : 'wasm',
  });
  return generatorPromise;
}

scope.onmessage = async (event: MessageEvent<LlmWorkerIn>) => {
  if (event.data?.type !== 'translate') return;
  try {
    const generator = await getGenerator();
    const parser = new LineParser((tag, text) => scope.postMessage({ type: 'line', tag, text }));
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk: string) => parser.push(chunk),
    });
    await generator(event.data.messages, {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      // A12: thinking mode off — reasoning must not leak into the 'N: text'
      // line format (the LineParser strips <arg_key>think> blocks as a backstop).
      chat_template_kwargs: { enable_thinking: false },
    });
    scope.postMessage({ type: 'done' });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
