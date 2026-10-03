/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * recording-process.ts: FFmpeg process control for HomeKit Secure Video event recordings.
 */

/**
 * FFmpeg process management for HomeKit Secure Video (HKSV) event recordings.
 *
 * @module
 */
import { BOX_TYPE_MDAT, BOX_TYPE_MOOV } from './fmp4.js';
import { FfmpegFMp4Process, type FMp4RecordingOptions } from './fmp4-process.js';
import { HKSV_IDR_INTERVAL, HKSV_TIMEOUT } from './settings.js';
import type { CameraRecordingConfiguration } from 'homebridge';
import type { FfmpegOptions } from './options.js';
import { once } from 'node:events';
import { runWithTimeout } from '../util.js';

/**
 * Manages a HomeKit Secure Video recording FFmpeg process.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegRecordingProcess(ffmpegOptions, recordingConfig, 30, true, 5000000, 0);
 * process.start();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegRecordingProcess extends FfmpegFMp4Process {

  /**
   * Indicates whether the recording has timed out waiting for FFmpeg output.
   */
  public isTimedOut: boolean;

  private readonly fps: number;
  private readonly probesize: number;
  private recordingBuffer: { data: Buffer, header: Buffer, length: number, type: number }[];
  private readonly timeshift: number;

  /**
   * Constructs a new FFmpeg recording process for HKSV events.
   *
   * @param options          - FFmpeg configuration options.
   * @param recordingConfig  - HomeKit recording configuration for the session.
   * @param fMp4Options      - fMP4 recording options.
   * @param isVerbose        - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4RecordingOptions> = {}, isVerbose = false) {

    super(options, recordingConfig, fMp4Options, isVerbose);

    // Store recording-specific options.
    this.fps = fMp4Options.fps ?? 30;
    this.isTimedOut = false;
    this.probesize = fMp4Options.probesize ?? 5000000;
    this.recordingBuffer = [];
    this.timeshift = fMp4Options.timeshift ?? 0;

    // Assemble the FFmpeg command line now that all state is initialized.
    this.buildCommandLine();
  }

  // Recording input: read fMP4 data from standard input with low-delay optimizations and an optional timeshift for HKSV event alignment.
  //
  // -flags low_delay              Tell FFmpeg to optimize for low delay / realtime decoding.
  // -probesize number             How many bytes should be analyzed for stream information.
  // -f mp4                        Tell FFmpeg that it should expect an MP4-encoded input stream.
  // -i pipe:0                     Use standard input to get video data.
  // -ss                           Fast forward to where HKSV is expecting us to be for a recording event.
  protected inputArgs(): string[] {

    return [

      '-flags', 'low_delay',
      '-probesize', this.probesize.toString(),
      '-f', 'mp4',
      '-i', 'pipe:0',
      '-ss', this.timeshift.toString() + 'ms',
    ];
  }

  // Recordings always read audio from the primary input...no separate audio source.
  protected separateAudioInputArgs(): string[] {

    return [];
  }

  // Audio is always on the primary input (index 0) for recordings.
  protected audioInputIndex(): number {

    return 0;
  }

  // Recordings transcode video using the platform-appropriate encoder for HKSV.
  protected videoEncoderArgs(): string[] {

    return this.options.recordEncoder({

      bitrate: this.recordingConfig.videoCodec.parameters.bitRate,
      fps: this.recordingConfig.videoCodec.resolution[2],
      hardwareDecoding: this.fMp4Options.hardwareDecoding,
      hardwareTranscoding: this.fMp4Options.hardwareTranscoding,
      height: this.recordingConfig.videoCodec.resolution[1],
      idrInterval: HKSV_IDR_INTERVAL,
      inputFps: this.fps,
      level: this.recordingConfig.videoCodec.parameters.level,
      profile: this.recordingConfig.videoCodec.parameters.profile,
      width: this.recordingConfig.videoCodec.resolution[0],
    });
  }

  // Recordings have no post-filter arguments.
  protected postFilterArgs(): string[] {

    return [];
  }

  // Metadata label identifying this as an HKSV event recording.
  protected metadataLabel(): string {

    return 'HKSV Event';
  }

  // Each parsed box is queued in the recording buffer for consumption by segmentGenerator().
  protected handleParsedBox(header: Buffer, data: Buffer, dataLength: number, type: number): void {

    this.recordingBuffer.push({ data, header, length: dataLength, type });
    this.emit('mp4box');
  }

  /**
   * Stops the FFmpeg process and performs cleanup, ensuring the segment generator can exit.
   */
  protected override stopProcess(): void {

    // Emit mp4box to unblock segmentGenerator() if it's waiting, then let the base class handle the rest.
    this._isEnded = true;
    this.emit('mp4box');

    super.stopProcess();
  }

  /**
   * Asynchronously generates complete segments from FFmpeg output, formatted for HomeKit Secure Video.
   *
   * This async generator yields fMP4 segments as Buffers, or ends on process termination or timeout.
   *
   * @yields A Buffer containing a complete MP4 segment suitable for HomeKit.
   *
   * @example
   *
   * ```ts
   * for await(const segment of process.segmentGenerator()) {
   *
   *   // Process each segment for HomeKit.
   * }
   * ```
   */
  public async *segmentGenerator(): AsyncGenerator<Buffer> {

    let segment: Buffer[] = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {

      // FFmpeg has finished its output - we're done.
      if(this._isEnded) {

        return;
      }

      // If the buffer is empty, wait for our FFmpeg process to produce more boxes.
      if(!this.recordingBuffer.length) {

        // Segments are output by FFmpeg according to our specified IDR interval. If we don't see a segment within the timeframe we need for HKSV's timing
        // requirements, we flag it accordingly and return null back to the generator that's calling us.
        await runWithTimeout(once(this, 'mp4box'), HKSV_TIMEOUT);
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // FFmpeg hasn't produced any output. Given the time-sensitive nature of HKSV that constrains us to no more than 5 seconds to provide the next segment,
      // we're done.
      if(!box) {

        this.isTimedOut = true;

        return;
      }

      // Queue up this fMP4 box to send back to HomeKit.
      segment.push(box.header, box.data);

      // What we want to send are two types of complete segments, made up of multiple MP4 boxes:
      //
      // - a complete MOOV box, usually with an accompanying FTYP box, that's sent at the very beginning of any valid fMP4 stream. HomeKit Secure Video looks
      // for this
      //   before anything else.
      //
      // - a complete MOOF/MDAT pair. MOOF describes the sample locations and their sizes and MDAT contains the actual audio and video data related to that
      // segment. Think
      //   of MOOF as the audio/video data "header", and MDAT as the "payload".
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === BOX_TYPE_MOOV) || (box.type === BOX_TYPE_MDAT)) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }
}
