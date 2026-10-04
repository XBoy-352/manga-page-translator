export type SrcLang = 'ja' | 'ko' | 'zh';
export type BackendKind = 'local' | 'remote' | 'nano';
export type InpaintMode = 'telea' | 'lama';

export interface Settings {
  srcLang: SrcLang;            // default 'ja'
  tgtLang: 'en';               // fixed in v1
  backend: BackendKind;        // default 'local'
  remoteUrl: string;           // default '' ; placeholder https://translator.mangal-coolify.duckdns.org/v1
  remoteApiKey: string;        // default '' ; sent as 'Authorization: Bearer <remoteApiKey>' when non-empty
  remoteModel: string;         // default 'qwen3.5-0.8b'
  inpaint: InpaintMode;        // default 'telea'
  lite: boolean;               // default false
  sfxThreshold: number;        // default 0.5
  glossary: { src: string; dst: string }[]; // default []
}

export interface Timings {
  sliceMs: number; detMs: number; recMs: number; clusterMs: number;
  inpaintMs: number; typesetMs: number; llmFirstMs?: number; llmTotalMs?: number;
}

export interface ProgressEvent {
  imageId: string;
  stage: 'download' | 'slice' | 'det' | 'rec' | 'cluster' | 'translate' | 'inpaint' | 'typeset' | 'done' | 'error';
  done: number; total: number;   // download: MB; translate: balloons; else steps
  detail?: string;
}

// messages (content ⇄ background)
export type BgRequest =
  | { kind: 'translate'; imageId: string; srcUrl: string; naturalWidth: number; naturalHeight: number }
  | { kind: 'restore'; imageId: string };
export type BgResponse =
  | { kind: 'progress'; event: ProgressEvent }
  | { kind: 'result'; imageId: string; ok: true; width: number; height: number; timings: Timings }
  | { kind: 'result'; imageId: string; ok: false; error: string }
  | { kind: 'imageBlob'; imageId: string; buf: ArrayBuffer; width: number; height: number };
