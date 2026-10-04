// Verbatim from docs/SPEC.md §7.9 — do not edit any URL or byte value.
// Byte values are exact HEAD-verified sizes (AC7 consent dialog).
// .onnx weights are Git-LFS objects (media CDN); the plain-text dictionaries
// are ordinary git blobs, which only raw.githubusercontent.com serves.
export const OCR_BASE = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
export const OCR_RAW_BASE = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
export interface ModelEntry { id: string; url: string; bytes: number; sha256?: undefined }
export const MODEL_REGISTRY: ModelEntry[] = [
  { id: 'det-small', url: `${OCR_BASE}/detection/PP-OCRv6_small_det.onnx`, bytes: 9_880_512 },
  { id: 'det-tiny',  url: `${OCR_BASE}/detection/PP-OCRv6_tiny_det.onnx`,  bytes: 1_780_590 },
  { id: 'rec-zh-small', url: `${OCR_BASE}/recognition/PP-OCRv6_small_rec.onnx`, bytes: 21_159_378 },
  { id: 'rec-zh-tiny',  url: `${OCR_BASE}/recognition/PP-OCRv6_tiny_rec.onnx`, bytes: 4_462_639 },
  { id: 'dict-zh-small', url: `${OCR_RAW_BASE}/recognition/ppocrv6_dict.txt`, bytes: 74_948 },
  { id: 'dict-zh-tiny',  url: `${OCR_RAW_BASE}/recognition/ppocrv6_tiny_dict.txt`, bytes: 27_157 },
  { id: 'rec-ja',   url: `${OCR_BASE}/recognition/multi/japan/v3/japan_PP-OCRv3_mobile_rec_infer.onnx`, bytes: 10_031_937 },
  { id: 'dict-ja',  url: `${OCR_RAW_BASE}/recognition/multi/japan/v3/japan_dict.txt`, bytes: 17_333 },
  { id: 'rec-ko',   url: `${OCR_BASE}/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx`, bytes: 13_443_278 },
  { id: 'dict-ko',  url: `${OCR_RAW_BASE}/recognition/multi/korean/v5/ppocrv5_korean_dict.txt`, bytes: 47_452 },
  { id: 'lama', url: 'https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/main/lama-manga-dynamic.onnx', bytes: 206_291_843 },
];
export const LOCAL_LLM = { repo: 'onnx-community/Qwen3.5-0.8B-Text-ONNX', dtype: 'q4', bytes: 570_473_438 };
