/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * livestream-process.ts: FFmpeg process control for fMP4 livestreaming.
 */

/**
 * FFmpeg process management for fMP4 livestreaming, remuxing an RTSP source into fMP4 segments with a captured initialization segment.
 *
 * @module
 */
import { FfmpegFMp4Process, type FMp4AudioInputConfig, type FMp4LivestreamOptions } from './fmp4-process.js';
import type { Nullable, PartialWithId } from '../util.js';
import { BOX_TYPE_MOOF } from './fmp4.js';
import type { CameraRecordingConfiguration } from 'homebridge';
import type { FfmpegOptions } from './options.js';
import { once } from 'node:events';

// Reusable empty buffer sentinel for resetting the initialization segment.
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Manages a HomeKit livestream FFmpeg process for generating fMP4 segments.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegLivestreamProcess(ffmpegOptions, recordingConfig, url, 30, true);
 * process.start();
 *
 * const initSegment = await process.getInitSegment();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegLivestreamProcess extends FfmpegFMp4Process {

  /**
   * Optional override for the fMP4 fragment duration, in milliseconds. When set, the `-frag_duration` argument is updated before starting the FFmpeg process.
   */
  public segmentLength?: number;

  // Set to true during separateAudioInputArgs() when a separate audio input is configured, so that audioInputIndex() returns the correct FFmpeg input index.
  private _hasAudioInput: boolean;
  private _initSegment: Buffer;
  private _initSegmentParts: Buffer[];
  private hasInitSegment: boolean;

  // A single shared wait for the initialization segment, settled when it arrives or aborted when the process stops or exits, so abandoned callers (e.g. those
  // that time out waiting) never leak event listeners.
  private initSegmentAbort: Nullable<AbortController>;
  private initSegmentPromise: Nullable<Promise<Buffer>>;
  private readonly livestreamOptions: PartialWithId<FMp4LivestreamOptions, 'url'>;

  /**
   * Constructs a new FFmpeg livestream process.
   *
   * @param options            - FFmpeg configuration options.
   * @param recordingConfig    - HomeKit recording configuration for the session.
   * @param livestreamOptions  - livestream segmenting options.
   * @param isVerbose          - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, livestreamOptions: PartialWithId<FMp4LivestreamOptions, 'url'>,
    isVerbose = false) {

    super(options, recordingConfig, livestreamOptions, isVerbose);

    // Store livestream-specific options.
    this._hasAudioInput = false;
    this._initSegment = Buffer.alloc(0);
    this._initSegmentParts = [];
    this.hasInitSegment = false;
    this.initSegmentAbort = null;
    this.initSegmentPromise = null;
    this.livestreamOptions = livestreamOptions;

    // Assemble the FFmpeg command line now that all state is initialized.
    this.buildCommandLine();
  }

  // Livestream input: connect to an RTSP source with direct I/O and TCP transport.
  //
  // -avioflags direct           Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
  // -rtsp_transport tcp         Tell the RTSP stream handler that we're looking for a TCP connection.
  // -i url                      RTSPS URL to get our input stream from.
  protected inputArgs(): string[] {

    return [

      '-avioflags', 'direct',
      '-rtsp_transport', 'tcp',
      '-i', this.livestreamOptions.url,
    ];
  }

  // If a separate audio input has been configured, build the FFmpeg input arguments for it. This enables support for devices like DoorBird where video and
  // audio are served from different endpoints.
  protected separateAudioInputArgs(): string[] {

    if(!this.fMp4Options.enableAudio || !this.livestreamOptions.audioInput) {

      return [];
    }

    const args: string[] = [];

    // Normalize the audio input configuration. A plain string is treated as a URL shorthand.
    const audioInput: FMp4AudioInputConfig = (typeof this.livestreamOptions.audioInput === 'string') ?
      { url: this.livestreamOptions.audioInput } :
      this.livestreamOptions.audioInput;

    // When a raw audio format is specified, we need to explicitly tell FFmpeg how to interpret the incoming stream since it cannot probe raw audio sources.
    //
    // -f format                       Specify the raw audio format (e.g., mulaw, alaw, s16le).
    // -ar sampleRate                  Specify the audio sample rate in Hz.
    // -ac channels                    Specify the number of audio channels.
    if(audioInput.format) {

      args.push('-f', audioInput.format, '-ar', (audioInput.sampleRate ?? 8000).toString(), '-ac', (audioInput.channels ?? 1).toString());
    }

    // For RTSP and RTSPS audio sources, we explicitly request TCP transport to match the behavior we use for the primary video input.
    if([ 'rtsp://', 'rtsps://' ].some((protocol) => audioInput.url.toLowerCase().startsWith(protocol))) {

      args.push('-rtsp_transport', 'tcp');
    }

    // -i url                          Audio input URL.
    args.push('-i', audioInput.url);

    // Track that we have a separate audio input so audioInputIndex() returns the correct value.
    this._hasAudioInput = true;

    return args;
  }

  // When a separate audio input is configured, audio is on the second FFmpeg input (index 1). Otherwise it shares the primary input (index 0).
  protected audioInputIndex(): number {

    return this._hasAudioInput ? 1 : 0;
  }

  // Livestreams remux the video stream directly without transcoding.
  protected videoEncoderArgs(): string[] {

    return [ '-codec:v', 'copy' ];
  }

  // Livestreams emit fMP4 fragments at one-second intervals by default.
  //
  // -frag_duration number       Length of each fMP4 fragment, in microseconds.
  protected postFilterArgs(): string[] {

    return [ '-frag_duration', '1000000' ];
  }

  // Metadata label identifying this as a livestream buffer.
  protected metadataLabel(): string {

    return 'Livestream Buffer';
  }

  // Livestream box handling: accumulate the initialization segment (everything before the first moof box), then emit each subsequent box as a segment event.
  protected handleParsedBox(header: Buffer, data: Buffer, _dataLength: number, type: number): void {

    // If this is part of the initialization segment, store it for future use.
    if(!this.hasInitSegment) {

      // The initialization segment is everything before the first moof box. Once we've seen a moof box, we know we've captured it in full. We collect the parts
      // into an array and concatenate once at the end to avoid creating intermediate buffers on every pre-moof box.
      if(type === BOX_TYPE_MOOF) {

        this._initSegment = Buffer.concat(this._initSegmentParts);
        this._initSegmentParts = [];
        this.hasInitSegment = true;
        this.emit('initsegment');
      } else {

        this._initSegmentParts.push(header, data);
      }
    }

    if(this.hasInitSegment) {

      // We only emit segments once we have the initialization segment.
      this.emit('segment', Buffer.concat([ header, data ]));
    }
  }

  /**
   * Configures the FFmpeg process, additionally ensuring any pending initialization segment wait is released if the process exits on its own.
   */
  protected override configureProcess(): void {

    super.configureProcess();

    // Our parent's exit handler runs first and clears the shared process reference when the current process exits. If it's still set, the exiting process was
    // superseded by a newer one whose pending waiters we must leave alone.
    this.process?.once('exit', () => {

      if(!this.process) {

        this.abortInitSegmentWait();
      }
    });
  }

  /**
   * Stops the FFmpeg process, rejecting any pending initialization segment wait.
   */
  protected override stopProcess(): void {

    this.abortInitSegmentWait();

    super.stopProcess();
  }

  /**
   * Starts the FFmpeg process, adjusting the fragment duration if segmentLength has been set.
   *
   * @example
   *
   * ```ts
   * process.start();
   * ```
   */
  public override start(): void {

    // Reset the initialization segment state so a restarted process's ftyp/moov boxes are captured anew rather than being emitted as media segments, and so
    // stale initialization data from the previous process is never served.
    this.hasInitSegment = false;
    this._initSegment = EMPTY_BUFFER;
    this._initSegmentParts = [];

    if(this.segmentLength !== undefined) {

      const fragIndex = this.commandLineArgs.indexOf('-frag_duration');

      if(fragIndex !== -1) {

        this.commandLineArgs[fragIndex + 1] = (this.segmentLength * 1000).toString();
      }
    }

    // Start the FFmpeg session.
    super.start();
  }

  /**
   * Gets the fMP4 initialization segment generated by FFmpeg for the livestream.
   *
   * @returns A promise resolving to the initialization segment as a Buffer.
   *
   * @remarks Concurrent callers share a single pending wait. If the process is not running, or stops or exits before the initialization segment arrives, the
   *   returned promise rejects. Callers should handle this rejection or wrap the call with a timeout.
   *
   * @example
   *
   * ```ts
   * const initSegment = await process.getInitSegment();
   * ```
   */
  public async getInitSegment(): Promise<Buffer> {

    // If we have the initialization segment, return it.
    if(this.hasInitSegment) {

      return this._initSegment;
    }

    // If there's no running process, there's nothing that can produce the initialization segment.
    if(!this.process) {

      throw new Error('No active FFmpeg livestream process.');
    }

    // Share a single pending wait across all callers until the initialization segment arrives or the process ends.
    return this.initSegmentPromise ??= this.awaitInitSegment();
  }

  // Wait for the initialization segment event, gated by an abort signal that is triggered when the process stops or exits.
  private async awaitInitSegment(): Promise<Buffer> {

    const abort = this.initSegmentAbort = new AbortController();

    try {

      await once(this, 'initsegment', { signal: abort.signal });

      return this._initSegment;
    } finally {

      // Only clear the shared state if it still belongs to this wait.
      if(this.initSegmentAbort === abort) {

        this.initSegmentAbort = null;
        this.initSegmentPromise = null;
      }
    }
  }

  // Release any pending initialization segment wait, rejecting it with an AbortError.
  private abortInitSegmentWait(): void {

    const abort = this.initSegmentAbort;

    this.initSegmentAbort = null;
    this.initSegmentPromise = null;
    abort?.abort();
  }

  /**
   * Returns the initialization segment as a Buffer, or null if not yet available.
   *
   * @returns The initialization segment Buffer, or `null` if not yet generated.
   *
   * @example
   *
   * ```ts
   * const init = process.initSegment;
   * if(init) {
   *
   *   // Use the initialization segment.
   * }
   * ```
   */
  public get initSegment(): Nullable<Buffer> {

    if(!this.hasInitSegment) {

      return null;
    }

    return this._initSegment;
  }
}
