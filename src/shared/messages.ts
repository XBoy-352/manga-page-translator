// Message types (BgRequest, BgResponse, ProgressEvent) are defined in §7.1 of
// docs/SPEC.md and live in shared/types.ts. This module is the content ⇄
// background messaging surface; slices s9+ wire the router onto these types.
export type { BgRequest, BgResponse, ProgressEvent } from './types';
