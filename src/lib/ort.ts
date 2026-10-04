// ORT session helpers for the OCR path (docs/SPEC.md §7.0): session creation
// with execution providers ['webgpu','wasm'] in that order (WebGPU is an
// accelerator, never a requirement — AC8), idle warmup of CACHED models only,
// and OCR worker spawn. Model bytes always come from the OPFS cache
// (lib/modelCache readModel) — this module has no network path.

// @ts-ignore -- onnxruntime-web ships types at ./types.d.ts but its package.json
// exports map has no "types" condition, so Bundler resolution cannot reach them
// (TS7016). Same workaround as src/worker/lama.worker.ts.
import * as ORT from 'onnxruntime-web';
import type { OrtTensorLike } from '../core/det';
import { cachedIds, readModel } from './modelCache';

export type OrtSession = ORT.InferenceSession;

/**
 * Creates a session with ['webgpu', 'wasm'] (§7.0). A WebGPU failure falls
 * back to a wasm-only session and is logged, never fatal.
 */
export async function createSession(bytes: ArrayBuffer): Promise<OrtSession> {
  try {
    return await ORT.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] });
  } catch (e) {
    console.warn('[ort] webgpu+wasm session failed, falling back to wasm:', e);
    return await ORT.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }
}

export function floatTensor(data: Float32Array, dims: readonly number[]): ORT.Tensor {
  return new ORT.Tensor('float32', data, dims);
}

/**
 * Runs one input through a session, bridging to the structural OrtRunner
 * shape used by core/det.ts and core/rec.ts (single-input PP-OCR models).
 */
export async function runSession(
  session: OrtSession,
  input: OrtTensorLike,
): Promise<Record<string, OrtTensorLike>> {
  const feeds: Record<string, ORT.Tensor> = {
    [session.inputNames[0]]: floatTensor(input.data, input.dims),
  };
  const results = await session.run(feeds);
  const out: Record<string, OrtTensorLike> = {};
  for (const name of session.outputNames) {
    const value = results[name];
    out[name] = { dims: value.dims, data: value.data as Float32Array };
  }
  return out;
}

// Memoized sessions keyed by registry model id. Loading goes through
// readModel (OPFS only, §7.10) — never a fetch.
const sessions = new Map<string, Promise<OrtSession>>();

export function getSession(modelId: string): Promise<OrtSession> {
  let pending = sessions.get(modelId);
  if (!pending) {
    pending = readModel(modelId).then((bytes) => createSession(bytes));
    // A failed load (e.g. model downloaded later) must be retryable.
    pending.catch(() => sessions.delete(modelId));
    sessions.set(modelId, pending);
  }
  return pending;
}

const DET_MODEL_IDS = ['det-small', 'det-tiny'] as const;
const REC_MODEL_IDS = ['rec-zh-small', 'rec-zh-tiny', 'rec-ja', 'rec-ko'] as const;

/**
 * Idle warmup over CACHED models only (§7.0): each cached det model gets one
 * 64×64 dummy inference (multiple-of-32 dims; compiles shaders / warms wasm
 * kernels), cached rec models get their sessions created. Never touches the
 * network; warmup failures are logged, never thrown.
 */
export async function warmupCachedModels(): Promise<void> {
  let cached: Set<string>;
  try {
    cached = await cachedIds();
  } catch {
    return; // no storage access here (e.g. plain node context) — nothing to warm
  }
  for (const id of DET_MODEL_IDS) {
    if (!cached.has(id)) continue;
    try {
      const session = await getSession(id);
      const x = floatTensor(new Float32Array(3 * 64 * 64), [1, 3, 64, 64]);
      await session.run({ [session.inputNames[0]]: x });
    } catch (e) {
      console.warn(`[ort] det warmup failed for ${id}:`, e);
    }
  }
  for (const id of REC_MODEL_IDS) {
    if (!cached.has(id)) continue;
    getSession(id).catch((e) => console.warn(`[ort] rec warmup failed for ${id}:`, e));
  }
}

/** Spawns the OCR worker (§7.0: ort.ts owns worker spawn). */
export function spawnOcrWorker(): Worker {
  // Vite bundles this URL into a module worker chunk.
  return new Worker(new URL('../worker/ocr.worker.ts', import.meta.url), { type: 'module' });
}
