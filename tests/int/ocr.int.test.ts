// Integration test (SPEC §11, local only): downloads det-tiny + rec-zh-tiny +
// dict-zh-tiny from MODEL_REGISTRY, runs detect + recognize on the committed
// tests/fixtures/bubble.png (black text "HELLO 123" / "WORLD 456" on white).
// Gated on RUN_INT=1: `RUN_INT=1 npm run test:int` — never runs in CI.
//
// The PNG is decoded by a minimal in-test decoder (8-bit RGB/RGBA/gray,
// non-interlaced) on top of node's zlib — no extra dependencies (§9).

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { detectWith } from '../../src/core/det';
import { buildCharset, recognizeCrops } from '../../src/core/rec';
import { createSession, runSession } from '../../src/lib/ort';
import { MODEL_REGISTRY } from '../../src/lib/modelRegistry';

const RUN_INT = process.env.RUN_INT === '1';
const suite = RUN_INT ? describe : describe.skip;

interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

function decodePng(bytes: Uint8Array): RawImage {
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (u32(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idats: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = u32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error('unsupported PNG interlacing');
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
      if (channels === 0) throw new Error(`unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') {
      idats.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width <= 0 || height <= 0 || channels === 0) throw new Error('missing IHDR');
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const row = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    row.set(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          row[i] = (row[i] + a) & 0xff;
          break;
        case 2:
          row[i] = (row[i] + b) & 0xff;
          break;
        case 3:
          row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const pa = Math.abs(b - c); // |p−a| with p = a+b−c simplifies to |b−c|
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          row[i] = (row[i] + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (channels === 1) {
        out[o] = out[o + 1] = out[o + 2] = row[s];
      } else {
        out[o] = row[s];
        out[o + 1] = row[s + 1];
        out[o + 2] = row[s + 2];
        if (channels === 4) out[o + 3] = row[s + 3];
      }
      out[o + 3] = channels === 4 ? row[s + 3] : 255;
    }
    prev.set(row);
  }
  return { width, height, data: out };
}

/**
 * Fetches a MODEL_REGISTRY entry. The registry URLs are binding (§7.9) and are
 * tried first; the media.githubusercontent.com CDN 404s for the plain-text
 * dict files (they are regular git blobs, unlike the LFS-stored .onnx files),
 * so a 404 falls back to raw.githubusercontent.com for the SAME repo, branch
 * and path — identical file, identical bytes. Flagged in docs/ASSUMPTIONS.md:
 * the shipped registry URLs for dict files need the same treatment (s2 owner).
 */
async function fetchRegistryBytes(id: string): Promise<ArrayBuffer> {
  const entry = MODEL_REGISTRY.find((e) => e.id === id);
  if (!entry) throw new Error(`missing MODEL_REGISTRY entry: ${id}`);
  let res = await fetch(entry.url);
  if (res.status === 404 && entry.url.startsWith('https://media.githubusercontent.com/media/')) {
    const rawUrl = entry.url.replace(
      'https://media.githubusercontent.com/media/',
      'https://raw.githubusercontent.com/',
    );
    console.warn(`[int] ${entry.url} → 404, retrying raw CDN: ${rawUrl}`);
    res = await fetch(rawUrl);
  }
  if (res.status !== 200) throw new Error(`Download failed (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  // Diagnostic only: the §7.9 registry byte constants do not match the real
  // files (det-tiny is 1,780,590 B vs the registry's 1,048,576; rec-zh-tiny
  // 4,462,639 vs 4,194,304). The registry is not editable from this slice —
  // flagged in docs/ASSUMPTIONS.md; AC7 consent sizes need an orchestrator fix.
  if (buf.byteLength !== entry.bytes) {
    console.warn(`[int] ${id}: actual ${buf.byteLength} B ≠ registry ${entry.bytes} B`);
  }
  return buf;
}

/** Axis-aligned bbox crop of a polygon, clamped to the page. */
function cropPolygon(page: RawImage, pts: Array<[number, number]>): ImageData {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(page.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(page.height - 1, Math.ceil(Math.max(...ys)));
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * page.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      data[d] = page.data[s];
      data[d + 1] = page.data[s + 1];
      data[d + 2] = page.data[s + 2];
      data[d + 3] = page.data[s + 3];
    }
  }
  return { width: w, height: h, data } as unknown as ImageData;
}

suite('ocr integration (real models — local only, RUN_INT=1)', () => {
  it(
    'detects bubbles and reads the fixture text with det-tiny + rec-zh-tiny',
    async () => {
      const [detBytes, recBytes, dictBytes] = await Promise.all([
        fetchRegistryBytes('det-tiny'),
        fetchRegistryBytes('rec-zh-tiny'),
        fetchRegistryBytes('dict-zh-tiny'),
      ]);
      const detSession = await createSession(detBytes);
      const recSession = await createSession(recBytes);
      const charset = buildCharset(new TextDecoder().decode(dictBytes));

      const png = decodePng(new Uint8Array(readFileSync(new URL('../fixtures/bubble.png', import.meta.url))));
      const page = png as unknown as ImageData;

      // Detect: ≥ 1 polygon on the synthetic bubble page (§7.3 pipeline).
      const polys = await detectWith((t) => runSession(detSession, t), page);
      console.log(`[int] det polygons: ${polys.length}`, polys.map((p) => p.score.toFixed(3)).join(', '));
      expect(polys.length).toBeGreaterThanOrEqual(1);

      // Recognize: decoded text matches the fixture content.
      const crops = polys.map((poly) => cropPolygon(page, poly.pts));
      const results = await recognizeCrops((t) => runSession(recSession, t), crops, charset);
      console.log('[int] rec:', results.map((r) => `${r.text} (${r.score.toFixed(3)})`).join(' | '));
      expect(results.some((r) => /HELLO/i.test(r.text))).toBe(true);
    },
    240_000,
  );
});
