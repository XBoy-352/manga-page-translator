// OPFS model cache per docs/SPEC.md §7.10.
// Files are staged at /models/.tmp/<id> while downloading and published to
// /models/<id> only after the full download completes.
import type { ModelEntry } from './modelRegistry';

const MODELS_DIR = 'models';
const TMP_DIR = '.tmp';
const BYTES_PER_MB = 1024 * 1024; // assumption taken -- MB means MiB (1,048,576 bytes); the registry's byte values are MiB-aligned so progress totals read as whole numbers.

// assumption taken -- §7.10 fixes the four exported functions, but the Models
// UI must be able to cancel mid-download ("cancelling deletes the .tmp file
// and caches nothing"), so fetchToOpfs takes an optional AbortSignal as a
// third parameter; two-argument calls per §7.10 remain valid.
export async function fetchToOpfs(
  entry: ModelEntry,
  onProgress: (mb: number, totalMb: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const models = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(MODELS_DIR, { create: true }));
  const tmp = await models.getDirectoryHandle(TMP_DIR, { create: true });
  const tmpHandle = await tmp.getFileHandle(entry.id, { create: true });
  let writable: FileSystemWritableFileStream | null = null;
  try {
    writable = await tmpHandle.createWritable();
    const res = await fetch(entry.url, { signal });
    if (res.status !== 200 || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      onProgress(received / BYTES_PER_MB, entry.bytes / BYTES_PER_MB);
    }
    await writable.close();
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* already closed */ }
    }
    try { await tmp.removeEntry(entry.id); } catch { /* nothing staged */ }
    throw toUserError(e);
  }
  // Publish: copy the staged tmp file into /models/<id>. The final
  // createWritable().close() is the atomic publish point (swap-file
  // semantics), so a failure mid-copy leaves no readable partial file.
  const hadPrevious = await fileExists(models, entry.id);
  try {
    const finalHandle = await models.getFileHandle(entry.id, { create: true });
    const out = await finalHandle.createWritable();
    try {
      const staged = await tmpHandle.getFile();
      const reader = staged.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await out.write(value);
      }
      await out.close();
    } catch (e) {
      try { await out.abort(); } catch { /* already closed */ }
      throw e;
    }
  } catch (e) {
    try { await tmp.removeEntry(entry.id); } catch { /* nothing staged */ }
    if (!hadPrevious) {
      // getFileHandle(create: true) may have left an empty placeholder —
      // a failed publish must cache nothing.
      try { await models.removeEntry(entry.id); } catch { /* never created */ }
    }
    throw toUserError(e);
  }
  try { await tmp.removeEntry(entry.id); } catch { /* nothing staged */ }
}

export async function cachedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const models = await findModelsDir();
  if (!models) return ids;
  for await (const [name, handle] of models.entries()) {
    if (handle.kind === 'file') ids.add(name);
  }
  return ids;
}

export async function readModel(id: string): Promise<ArrayBuffer> {
  const models = await findModelsDir();
  if (models) {
    try {
      const handle = await models.getFileHandle(id);
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  throw new Error(`Model not cached: ${id}`);
}

export async function clearModels(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(MODELS_DIR, { recursive: true });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

async function findModelsDir(): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(MODELS_DIR);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'NotFoundError';
}

function toUserError(e: unknown): Error {
  // §10: OPFS quota exceeded stops cleanly with 'Storage full'.
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return new Error('Storage full');
  if (e instanceof Error) return e;
  return new Error(String(e));
}
