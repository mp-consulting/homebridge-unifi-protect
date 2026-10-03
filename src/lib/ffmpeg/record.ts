/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * record.ts: Provide FFmpeg process control to support livestreaming and HomeKit Secure Video.
 */

/**
 * FFmpeg process management for HomeKit Secure Video (HKSV) events and fMP4 livestreaming.
 *
 * This module is a compatibility barrel. The implementation lives in one file per class:
 *
 * - `fmp4-process.ts`       - Shared fMP4 option interfaces and the abstract `FfmpegFMp4Process` base class.
 * - `recording-process.ts`  - `FfmpegRecordingProcess`, for HKSV event recordings.
 * - `livestream-process.ts` - `FfmpegLivestreamProcess`, for fMP4 livestreaming.
 *
 * @module
 */
export type { FMp4AudioInputConfig, FMp4BaseOptions, FMp4LivestreamOptions, FMp4RecordingOptions } from './fmp4-process.js';
export { FfmpegLivestreamProcess } from './livestream-process.js';
export { FfmpegRecordingProcess } from './recording-process.js';
