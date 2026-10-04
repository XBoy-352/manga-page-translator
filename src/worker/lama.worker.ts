// LaMa inpaint worker (docs/SPEC.md §7.0, §7.7): receives
// { buf, width, height, maskBuf }, loads the 'lama' model via the OPFS cache
// (§7.10 readModel), runs patch-wise LaMa inpainting, and returns the patched
// RGBA buffer. onnxruntime is wired here — session creation lives in this
// worker rather than lib/ort.ts (which belongs to slice s4's OCR path).
import { readModel } from '../lib/modelCache';
import { inpaintLama, type LamaSessionRunner } from '../core/inpaint/lama';
// @ts-ignore -- onnxruntime-web ships types at ./types.d.ts but its package.json
// exports map has no "types" condition, so Bundler resolution cannot reach them
// (TS7016). Only this worker touches ORT; no exported signature depends on it.
import * as ORT from 'onnxruntime-web';

// assumption taken -- the message protocol shape { buf, width, height, maskBuf }
// is fixed by the s6 slice contract; the reply is the patched RGBA buffer as a
// transferred ArrayBuffer ("returns the patched buffer").
interface LamaRequest {
  buf: ArrayBuffer;
  width: number;
  height: number;
  maskBuf: ArrayBuffer;
}

// Structural view of the worker global scope (avoids pulling lib.webworker
// into the DOM-lib build).
interface WorkerCtx {
  postMessage(message: ArrayBuffer, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerCtx;

let sessionP: Promise<ORT.InferenceSession> | null = null;

async function getSession(): Promise<ORT.InferenceSession> {
  if (!sessionP) {
    sessionP = (async () => {
      const model = await readModel('lama');
      try {
        // §7.0: execution providers are always ['webgpu', 'wasm'] in this
        // order — WebGPU is an accelerator, never a requirement.
        return await ORT.InferenceSession.create(model, { executionProviders: ['webgpu', 'wasm'] });
      } catch {
        // Firefox without WebGPU (AC8): fall back to the WASM provider.
        return await ORT.InferenceSession.create(model, { executionProviders: ['wasm'] });
      }
    })();
  }
  return sessionP;
}

// lama-manga-dynamic.onnx graph I/O (verified from the model file):
//   image  [batch, 3, h, w] float32 — RGB in [0,1]
//   mask   [batch, 1, h, w] float32 — 1.0 = hole
//   output 'inpainted' [batch, 3, h, w] float32
const runLamaSession: LamaSessionRunner = async (patch) => {
  const session = await getSession();
  const image = new ORT.Tensor('float32', patch.image, [1, 3, patch.height, patch.width]);
  const mask = new ORT.Tensor('float32', patch.mask, [1, 1, patch.height, patch.width]);
  const results = await session.run({ image, mask });
  return results.inpainted.data as Float32Array;
};

ctx.addEventListener('message', (ev: MessageEvent) => {
  void (async () => {
    const req = ev.data as LamaRequest;
    const rgba = new ImageData(new Uint8ClampedArray(req.buf), req.width, req.height);
    const out = await inpaintLama(rgba, new Uint8Array(req.maskBuf), runLamaSession);
    ctx.postMessage(out.data.buffer, [out.data.buffer]);
  })();
});
