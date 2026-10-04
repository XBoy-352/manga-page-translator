import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OCR_BASE, OCR_RAW_BASE, LOCAL_LLM, MODEL_REGISTRY, type ModelEntry } from '../src/lib/modelRegistry';
import { cachedIds, clearModels, fetchToOpfs, readModel } from '../src/lib/modelCache';

// ---------- fake OPFS: in-memory stand-in for navigator.storage.getDirectory() ----------

class FakeWritable {
  closed = false;
  constructor(
    private chunks: Uint8Array[],
    private publish: (data: Uint8Array) => void,
    private quota: boolean,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('write after close');
    if (this.quota) throw new DOMException('quota exceeded', 'QuotaExceededError');
    this.chunks.push(chunk);
  }
  async close(): Promise<void> {
    this.closed = true;
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    this.publish(out);
  }
  async abort(): Promise<void> {
    this.closed = true;
  }
}

class FakeFile {
  readonly kind = 'file' as const;
  quota = false;
  data: Uint8Array | null = null;
  constructor(readonly name: string) {}
  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; stream(): ReadableStream<Uint8Array> }> {
    if (this.data === null) throw new DOMException('not found', 'NotFoundError');
    const data = this.data;
    return {
      arrayBuffer: () => Promise.resolve(data.slice().buffer as ArrayBuffer),
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (data.byteLength > 0) controller.enqueue(data);
            controller.close();
          },
        }),
    };
  }
  async createWritable(): Promise<FakeWritable> {
    const chunks: Uint8Array[] = [];
    return new FakeWritable(chunks, (data) => { this.data = data; }, this.quota);
  }
}

class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | FakeFile>();
  fileQuota = false;
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const found = this.children.get(name);
    if (found) {
      if (found instanceof FakeDir) return found;
      throw new DOMException('a file exists with this name', 'TypeMismatchError');
    }
    if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
    const dir = new FakeDir(name);
    dir.fileQuota = this.fileQuota;
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const found = this.children.get(name);
    if (found) {
      if (found instanceof FakeFile) return found;
      throw new DOMException('a directory exists with this name', 'TypeMismatchError');
    }
    if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
    const file = new FakeFile(name);
    file.quota = this.fileQuota;
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }
  async *entries(): AsyncGenerator<[string, FakeDir | FakeFile]> {
    for (const entry of [...this.children]) yield entry;
  }
}

function modelsDirOf(root: FakeDir): FakeDir {
  const models = root.children.get('models');
  if (!(models instanceof FakeDir)) throw new Error('models dir missing');
  return models;
}

async function tmpIsEmpty(root: FakeDir): Promise<boolean> {
  const tmp = modelsDirOf(root).children.get('.tmp');
  return tmp instanceof FakeDir ? tmp.children.size === 0 : true;
}

function stubNavigator(root: FakeDir): void {
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
}

function stubFetch(chunks: Uint8Array[]): void {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    (async () => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        }),
      },
    })) as unknown as typeof fetch,
  );
}

function stubFetchStatus(status: number): void {
  vi.stubGlobal('fetch', (async () => ({ status, body: null })) as unknown as typeof fetch);
}

const MIB = 1024 * 1024;
const ENTRY: ModelEntry = { id: 'det-tiny', url: 'https://example.test/PP-OCRv6_tiny_det.onnx', bytes: 3 * MIB };

let root: FakeDir;

beforeEach(() => {
  root = new FakeDir('root');
  stubNavigator(root);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- registry ----------

describe('MODEL_REGISTRY (spec §7.9, verbatim)', () => {
  it('contains exactly the 11 spec entries with byte-verbatim URLs and sizes', () => {
    const base = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
    const raw = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
    expect(OCR_BASE).toBe(base);
    expect(OCR_RAW_BASE).toBe(raw);
    expect(MODEL_REGISTRY).toHaveLength(11);
    expect(MODEL_REGISTRY).toEqual([
      { id: 'det-small', url: `${base}/detection/PP-OCRv6_small_det.onnx`, bytes: 9_880_512 },
      { id: 'det-tiny', url: `${base}/detection/PP-OCRv6_tiny_det.onnx`, bytes: 1_780_590 },
      { id: 'rec-zh-small', url: `${base}/recognition/PP-OCRv6_small_rec.onnx`, bytes: 21_159_378 },
      { id: 'rec-zh-tiny', url: `${base}/recognition/PP-OCRv6_tiny_rec.onnx`, bytes: 4_462_639 },
      { id: 'dict-zh-small', url: `${raw}/recognition/ppocrv6_dict.txt`, bytes: 74_948 },
      { id: 'dict-zh-tiny', url: `${raw}/recognition/ppocrv6_tiny_dict.txt`, bytes: 27_157 },
      { id: 'rec-ja', url: `${base}/recognition/multi/japan/v3/japan_PP-OCRv3_mobile_rec_infer.onnx`, bytes: 10_031_937 },
      { id: 'dict-ja', url: `${raw}/recognition/multi/japan/v3/japan_dict.txt`, bytes: 17_333 },
      { id: 'rec-ko', url: `${base}/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx`, bytes: 13_443_278 },
      { id: 'dict-ko', url: `${raw}/recognition/multi/korean/v5/ppocrv5_korean_dict.txt`, bytes: 47_452 },
      { id: 'lama', url: 'https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/main/lama-manga-dynamic.onnx', bytes: 206_291_843 },
    ]);
  });

  it('LOCAL_LLM matches the spec verbatim', () => {
    expect(LOCAL_LLM).toEqual({ repo: 'onnx-community/Qwen3.5-0.8B-Text-ONNX', dtype: 'q4', bytes: 570_473_438 });
  });
});

// ---------- model cache ----------

describe('modelCache', () => {
  it('starts with an empty cache', async () => {
    await expect(cachedIds()).resolves.toEqual(new Set());
  });

  it('downloads to /models/<id>, reports progress in MB, and cleans the tmp staging area', async () => {
    stubFetch([new Uint8Array(MIB).fill(1), new Uint8Array(MIB).fill(2), new Uint8Array(MIB).fill(3)]);
    const progress: Array<[number, number]> = [];
    await fetchToOpfs(ENTRY, (mb, totalMb) => progress.push([mb, totalMb]));

    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    await expect(cachedIds()).resolves.toEqual(new Set(['det-tiny']));
    await expect(tmpIsEmpty(root)).resolves.toBe(true);

    const buf = await readModel('det-tiny');
    const bytes = new Uint8Array(buf);
    expect(buf.byteLength).toBe(3 * MIB);
    expect(bytes[0]).toBe(1);
    expect(bytes[MIB]).toBe(2);
    expect(bytes[2 * MIB]).toBe(3);
  });

  it('cachedIds lists files only (never the .tmp staging directory)', async () => {
    stubFetch([new Uint8Array(4).fill(7)]);
    await fetchToOpfs(ENTRY, () => {});
    expect(modelsDirOf(root).children.has('.tmp')).toBe(true);
    await expect(cachedIds()).resolves.toEqual(new Set(['det-tiny']));
  });

  it('HTTP 404 → Download failed (HTTP 404), nothing cached, tmp cleaned', async () => {
    stubFetchStatus(404);
    await expect(fetchToOpfs(ENTRY, () => {})).rejects.toThrow('Download failed (HTTP 404)');
    await expect(cachedIds()).resolves.toEqual(new Set());
    await expect(tmpIsEmpty(root)).resolves.toBe(true);
    expect(modelsDirOf(root).children.has('det-tiny')).toBe(false);
  });

  it('HTTP 500 → Download failed (HTTP 500)', async () => {
    stubFetchStatus(500);
    await expect(fetchToOpfs(ENTRY, () => {})).rejects.toThrow('Download failed (HTTP 500)');
    await expect(cachedIds()).resolves.toEqual(new Set());
  });

  it('quota exceeded during download → Storage full, nothing cached', async () => {
    const models = new FakeDir('models');
    models.fileQuota = true;
    root.children.set('models', models);
    stubFetch([new Uint8Array(MIB).fill(1)]);
    await expect(fetchToOpfs(ENTRY, () => {})).rejects.toThrow('Storage full');
    await expect(cachedIds()).resolves.toEqual(new Set());
    await expect(tmpIsEmpty(root)).resolves.toBe(true);
    expect(models.children.has('det-tiny')).toBe(false);
  });

  it('quota exceeded during publish → Storage full and no empty placeholder left in /models', async () => {
    const models = new FakeDir('models');
    models.fileQuota = true;
    const tmp = new FakeDir('.tmp');
    tmp.fileQuota = false; // staging succeeds, publishing hits the quota
    models.children.set('.tmp', tmp);
    root.children.set('models', models);
    stubFetch([new Uint8Array(4).fill(7)]);
    await expect(fetchToOpfs(ENTRY, () => {})).rejects.toThrow('Storage full');
    await expect(cachedIds()).resolves.toEqual(new Set());
    expect(models.children.has('det-tiny')).toBe(false);
    await expect(tmpIsEmpty(root)).resolves.toBe(true);
  });

  it('cancelling mid-download deletes the .tmp file and caches nothing', async () => {
    stubFetch([new Uint8Array(MIB).fill(1), new Uint8Array(MIB).fill(2), new Uint8Array(MIB).fill(3)]);
    const controller = new AbortController();
    const progress = vi.fn((mb: number) => {
      if (mb >= 1) controller.abort();
    });
    const promise = fetchToOpfs(ENTRY, progress, controller.signal);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cachedIds()).resolves.toEqual(new Set());
    await expect(tmpIsEmpty(root)).resolves.toBe(true);
    expect(modelsDirOf(root).children.has('det-tiny')).toBe(false);
  });

  it('readModel throws "Model not cached: <id>" for absent models', async () => {
    await expect(readModel('rec-ja')).rejects.toThrow('Model not cached: rec-ja');
  });

  it('clearModels empties the cache and the dir is recreated on the next download', async () => {
    stubFetch([new Uint8Array(4).fill(7)]);
    await fetchToOpfs(ENTRY, () => {});
    await clearModels();
    await expect(cachedIds()).resolves.toEqual(new Set());
    await expect(readModel('det-tiny')).rejects.toThrow('Model not cached: det-tiny');

    stubFetch([new Uint8Array(2).fill(9)]);
    await fetchToOpfs(ENTRY, () => {});
    await expect(cachedIds()).resolves.toEqual(new Set(['det-tiny']));
  });
});
