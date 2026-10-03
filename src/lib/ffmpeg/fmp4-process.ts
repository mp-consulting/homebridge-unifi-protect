/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * fmp4-process.ts: Shared FFmpeg process plumbing for fMP4 recording and livestreaming sessions.
 */

/**
 * Shared fMP4 FFmpeg process foundation for HomeKit Secure Video (HKSV) events and fMP4 livestreaming.
 *
 * This module defines the option interfaces shared by fMP4 sessions and the abstract `FfmpegFMp4Process` base class, which owns the common FFmpeg command line
 * skeleton and feeds FFmpeg's fMP4 output through an incremental box reader. Concrete modes live in `recording-process.ts` and `livestream-process.ts`.
 *
 * @module
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, type CameraRecordingConfiguration, type StreamRequestCallback } from 'homebridge';
import { FMp4BoxReader, type FMp4ParsedBox } from './fmp4.js';
import type { FfmpegOptions } from './options.js';
import { FfmpegProcess } from './process.js';
import type { Nullable } from '../util.js';

// Utility to map HKSV audio recording codec types to their AAC Object Type identifiers. We also use satisfies here to ensure we account for any future changes
// that would require updating this mapping.
const translateAudioRecordingCodecType = {

  [AudioRecordingCodecType.AAC_ELD]: '38',
  [AudioRecordingCodecType.AAC_LC]: '1',
} satisfies Record<AudioRecordingCodecType, string>;

// Utility to map audio sample rates to strings. We also use satisfies here to ensure we account for any future changes that would require updating this
// mapping.
const translateAudioSampleRate = {

  [AudioRecordingSamplerate.KHZ_8]: '8',
  [AudioRecordingSamplerate.KHZ_16]: '16',
  [AudioRecordingSamplerate.KHZ_24]: '24',
  [AudioRecordingSamplerate.KHZ_32]: '32',
  [AudioRecordingSamplerate.KHZ_44_1]: '44.1',
  [AudioRecordingSamplerate.KHZ_48]: '48',
} satisfies Record<AudioRecordingSamplerate, string>;

// Known HKSV-related errors due to occasional inconsistencies produced by the input stream and FFmpeg's own occasional quirkiness. Compiled once at module
// scope rather than on every error event.
const FFMPEG_KNOWN_HKSV_ERROR = new RegExp([

  '(Cannot determine format of input stream 0:0 after EOF)',
  '(Could not write header \\(incorrect codec parameters \\?\\): Broken pipe)',
  '(Could not write header for output file #0)',
  '(Error closing file: Broken pipe)',
  '(Error splitting the input into NAL units\\.)',
  '(Invalid data found when processing input)',
  '(moov atom not found)',
].join('|'));

/**
 * Base options shared by both fMP4 recording and livestream sessions.
 *
 * @property audioFilters        - Audio filters for FFmpeg to process. These are passed as an array of filters.
 * @property audioStream         - Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream).
 * @property codec               - The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`.
 * @property enableAudio         - Indicates whether to enable audio or not.
 * @property hardwareDecoding    - Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property hardwareTranscoding - Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property transcodeAudio      - Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`.
 * @property videoFilters        - Video filters for FFmpeg to process. These are passed as an array of filters.
 * @property videoStream         - Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream).
 */
export interface FMp4BaseOptions {

  audioFilters: string[];
  audioStream: number;
  codec: string;
  enableAudio: boolean;
  hardwareDecoding: boolean;
  hardwareTranscoding: boolean;
  transcodeAudio: boolean;
  videoFilters: string[];
  videoStream: number;
}

/**
 * Configuration for a separate audio input source in an fMP4 livestream session. This interface describes the audio source when video and audio come from
 * different endpoints, such as cameras like DoorBird that expose audio through a separate HTTP API.
 *
 * When the audio source is a raw stream (not a self-describing container), specify `format`, `sampleRate`, and optionally `channels` so FFmpeg knows how to
 * interpret the input. For self-describing sources like RTSP or container-based HTTP streams, only `url` is required.
 *
 * @property channels    - Optional. Number of audio channels. Defaults to `1`.
 * @property format      - Optional. Raw audio format for the input stream. When set, FFmpeg is told to expect this format rather than probing the stream.
 *                         Valid values are `alaw` (G.711 A-law), `mulaw` (G.711 mu-law), and `s16le` (16-bit signed little-endian PCM). Omit for
 *                         self-describing sources.
 * @property sampleRate  - Optional. Audio sample rate in Hz (e.g., `8000`). Used when `format` is set. Defaults to `8000`.
 * @property url         - The URL of the audio input source.
 *
 * @example
 *
 * ```ts
 * // Raw audio from a DoorBird audio.cgi endpoint.
 * const rawAudioInput: FMp4AudioInputConfig = {
 *
 *   format: "mulaw",
 *   sampleRate: 8000,
 *   url: "http://doorbird-ip/bha-api/audio.cgi"
 * };
 *
 * // Self-describing RTSP audio stream - only URL is needed.
 * const rtspAudioInput: FMp4AudioInputConfig = {
 *
 *   url: "rtsp://camera-ip/audio"
 * };
 * ```
 *
 * @see FMp4LivestreamOptions
 *
 * @category FFmpeg
 */
export interface FMp4AudioInputConfig {

  channels?: number;
  format?: 'alaw' | 'mulaw' | 's16le';
  sampleRate?: number;
  url: string;
}

/**
 * Options for configuring an fMP4 HKSV recording session.
 *
 * @property fps             - The video frames per second for the session.
 * @property probesize       - Number of bytes to analyze for stream information.
 * @property timeshift       - Timeshift offset for event-based recording (in milliseconds).
 */
export interface FMp4RecordingOptions extends FMp4BaseOptions {

  fps: number;
  probesize: number;
  timeshift: number;
}

/**
 * Options for configuring an fMP4 livestream session.
 *
 * @property audioInput  - Optional. A separate audio input source. When provided, audio is read from this source instead of the primary `url`. Can be a URL
 *                         string for self-describing sources (e.g., RTSP), or an `FMp4AudioInputConfig` object for raw audio streams that require format
 *                         metadata.
 * @property url         - Source URL for livestream (RTSP) remuxing to fMP4.
 *
 * @see FMp4AudioInputConfig
 *
 * @category FFmpeg
 */
export interface FMp4LivestreamOptions extends FMp4BaseOptions {

  audioInput?: FMp4AudioInputConfig | string;
  url: string;
}

/**
 * Abstract base class for fMP4 FFmpeg processes. Owns the shared command line skeleton (preamble, video mapping, movflags, audio encoding, output format) and
 * the fMP4 box-parsing loop. Subclasses provide mode-specific pieces (input args, encoder selection, box handling) via protected hook methods, following the
 * template method pattern.
 *
 * @see FfmpegRecordingProcess
 * @see FfmpegLivestreamProcess
 * @see FfmpegProcess
 * @see {@link https://ffmpeg.org/ffmpeg.html | FFmpeg Documentation}
 */
export abstract class FfmpegFMp4Process extends FfmpegProcess {

  // Latch ensuring the close event fires at most once per process lifecycle - stop() can be invoked multiple times for the same process.
  private hasEmittedClose: boolean;

  private isLoggingErrors: boolean;

  // The HomeKit recording configuration and resolved base options are stored as protected fields so subclass hook methods can reference them without needing
  // their own copies of the shared state.
  protected readonly fMp4Options: Required<FMp4BaseOptions>;
  protected readonly recordingConfig: CameraRecordingConfiguration;

  /**
   * Constructs a new fMP4 FFmpeg process. Stores shared state and applies defaults to the base options. The command line is not assembled here...subclasses
   * call
   * `buildCommandLine()` after their own initialization to trigger the template method assembly.
   *
   * @param ffmpegOptions     - FFmpeg configuration options.
   * @param recordingConfig   - HomeKit recording configuration for the session.
   * @param fMp4Options       - Partial base options with defaults applied for any unset fields.
   * @param isVerbose         - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(ffmpegOptions: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4BaseOptions> = {}, isVerbose = false) {

    // Initialize our parent.
    super(ffmpegOptions);

    // We haven't emitted a close event yet for this lifecycle.
    this.hasEmittedClose = false;

    // We want to log errors when they occur.
    this.isLoggingErrors = true;

    // Store the recording configuration for use by subclass hook methods.
    this.recordingConfig = recordingConfig;

    // Apply defaults to the base options and store them. Subclasses store their own mode-specific options separately.
    this.fMp4Options = {

      audioFilters: fMp4Options.audioFilters ?? [],
      audioStream: fMp4Options.audioStream ?? 0,
      codec: fMp4Options.codec ?? 'h264',
      enableAudio: fMp4Options.enableAudio ?? true,
      hardwareDecoding: fMp4Options.hardwareDecoding ?? (this.options.codecSupport.ffmpegVersion.startsWith('8.') ? this.options.config.hardwareDecoding : false),
      hardwareTranscoding: fMp4Options.hardwareTranscoding ?? this.options.config.hardwareTranscoding,
      transcodeAudio: fMp4Options.transcodeAudio ?? true,
      videoFilters: fMp4Options.videoFilters ?? [],
      videoStream: fMp4Options.videoStream ?? 0,
    };

    // Store the verbose flag for use during command line assembly. We don't build the command line here...subclasses call buildCommandLine() after initializing
    // their own state, which avoids the virtual-call-from-constructor problem.
    this._isVerbose = isVerbose;
  }

  // Per-instance verbose flag, distinct from the inherited isVerbose which reflects the global codecSupport.verbose setting. We keep both so either a global
  // debug setting or a per-session opt-in can enable verbose FFmpeg logging...the check in buildCommandLine() ORs them together.
  private _isVerbose: boolean;

  // Assembles the FFmpeg command line by calling hook methods in the standard order. The shared skeleton lives here; mode-specific pieces come from subclass
  // overrides. Subclasses call this as the last step of their constructor, after their own state is fully initialized.
  protected buildCommandLine(): void {

    // Configure our video parameters for our input:
    //
    // -hide_banner                  Suppress printing the startup banner in FFmpeg.
    // -nostats                      Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags                 Set the format flags to discard any corrupt packets rather than exit.
    // -err_detect ignore_err        Ignore decoding errors and continue rather than exit.
    // -max_delay 500000             Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    this.commandLineArgs = [

      '-hide_banner',
      '-nostats',
      '-fflags', '+discardcorrupt',
      '-err_detect', 'ignore_err',
      ...this.options.videoDecoder(this.fMp4Options.codec),
      '-max_delay', '500000',

      // Mode-specific input arguments (RTSP input for livestream, stdin pipe for recording).
      ...this.inputArgs(),

      // Mode-specific separate audio input arguments (livestream with a separate audio endpoint, empty for recording).
      ...this.separateAudioInputArgs(),
    ];

    // Configure our recording options for the video stream:
    //
    // -map 0:v:X                    Selects the video track from the input.
    this.commandLineArgs.push('-map', '0:v:' + this.fMp4Options.videoStream.toString(),

      // Mode-specific video encoder arguments (copy for livestream, recordEncoder for recording).
      ...this.videoEncoderArgs());

    // Configure our video filters, if we have them.
    if(this.fMp4Options.videoFilters.length) {

      this.commandLineArgs.push('-filter:v', this.fMp4Options.videoFilters.join(', '));
    }

    // Mode-specific post-filter arguments (frag_duration for livestream, empty for recording).
    this.commandLineArgs.push(...this.postFilterArgs());

    // -movflags flags               In the generated fMP4 stream: set the default-base-is-moof flag in the header, write an initial empty MOOV box, start a
    //                               new fragment at each keyframe, skip creating a segment index (SIDX) box in fragments, and skip writing the final MOOV
    //                               trailer since
    // it's unneeded.
    // -flush_packets 1              Ensure we flush our write buffer after each muxed packet.
    // -reset_timestamps             Reset timestamps at the beginning of each segment.
    // -metadata                     Set the metadata to the name of the camera to distinguish between FFmpeg sessions.
    this.commandLineArgs.push(
      '-movflags', 'default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer',
      '-flush_packets', '1',
      '-reset_timestamps', '1',
      '-metadata', 'comment=' + this.options.name() + ' ' + this.metadataLabel());

    // Assemble the audio encoding block. This is shared between both modes...the only mode-specific piece is which FFmpeg input index carries the audio stream.
    let transcodeAudio = this.fMp4Options.transcodeAudio;

    if(this.fMp4Options.enableAudio) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map N:a:X?                 Selects the audio stream from input N, if it exists. The input index is 0 when audio and video share the same input, or 1
      //                             when a separate audio input has been configured.
      this.commandLineArgs.push('-map', this.audioInputIndex().toString() + ':a:' + this.fMp4Options.audioStream.toString() + '?');

      // Configure our audio filters, if we have them.
      if(this.fMp4Options.audioFilters.length) {

        this.commandLineArgs.push('-filter:a', this.fMp4Options.audioFilters.join(', '));

        // Audio filters require transcoding. If the user has decided to filter, we enforce this requirement even if they wanted to copy the audio stream.
        transcodeAudio = true;
      }

      if(transcodeAudio) {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a                    Encode using the codecs available to us on given platforms.
        // -profile:a                  Specify either low-complexity AAC or enhanced low-delay AAC for HKSV events.
        // -ar samplerate              Sample rate to use for this audio. This is specified by HKSV.
        // -ac number                  Set the number of audio channels.
        this.commandLineArgs.push(
          ...this.options.audioEncoder({ codec: this.recordingConfig.audioCodec.type }),
          '-profile:a', translateAudioRecordingCodecType[this.recordingConfig.audioCodec.type],
          '-ar', translateAudioSampleRate[this.recordingConfig.audioCodec.samplerate as AudioRecordingSamplerate] + 'k',
          '-ac', (this.recordingConfig.audioCodec.audioChannels ?? 1).toString());
      } else {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a copy               Copy the audio stream, since it's already in AAC.
        this.commandLineArgs.push('-codec:a', 'copy');
      }
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4                        Tell ffmpeg that it should create an MP4-encoded output stream.
    // pipe:1                        Output the stream to standard output.
    this.commandLineArgs.push('-f', 'mp4', 'pipe:1');

    // Additional logging, but only if we're debugging.
    if(this._isVerbose || this.isVerbose) {

      this.commandLineArgs.unshift('-loglevel', 'level+verbose');
    }
  }

  protected abstract inputArgs(): string[];
  protected abstract separateAudioInputArgs(): string[];
  protected abstract audioInputIndex(): number;
  protected abstract videoEncoderArgs(): string[];
  protected abstract postFilterArgs(): string[];
  protected abstract metadataLabel(): string;
  protected abstract handleParsedBox(header: Buffer, data: Buffer, dataLength: number, type: number): void;

  /**
   * Prepares and configures the FFmpeg process for reading and parsing output fMP4 data. The box parsing loop is shared...each complete box is dispatched to
   * the subclass via handleParsedBox().
   */
  protected override configureProcess(): void {

    let dataListener: (buffer: Buffer) => void;

    // Capture the child we're configuring - the parent's exit handler nulls the shared process reference before our own exit listener runs, and on a reused
    // instance the shared reference may already point at a newly started process.
    const childProcess = this.process;

    // Call our parent to get started.
    super.configureProcess();

    // Each process lifecycle gets its own box reader so partial data from a previous process can never bleed into a newly started one.
    const boxReader = new FMp4BoxReader();

    // Dispatch each complete box to the subclass for mode-specific handling.
    const onBox = (box: FMp4ParsedBox): void => this.handleParsedBox(box.header, box.data, box.length, box.type);

    // Process FFmpeg output and parse out the fMP4 stream it's generating, splitting it up into the MP4 boxes that HAP-NodeJS is ultimately expecting. The box
    // reader handles boxes split across arbitrary chunk boundaries.
    childProcess?.stdout.on('data', dataListener = (buffer: Buffer): void => {

      if(boxReader.push(buffer, onBox)) {

        return;
      }

      // A box size smaller than the header size - zero-size, open-ended (size 0), or extended-size (size 1) boxes - leaves the stream unparseable, so we treat
      // it as fatally corrupt and shut the process down.
      this.log.error('Invalid fMP4 box size (%s) detected in the FFmpeg output stream. Ending this session.', boxReader.invalidBoxSize);
      childProcess.stdout.off('data', dataListener);
      this.stop();
    });

    // Make sure we cleanup our listeners when we're done.
    childProcess?.once('exit', () => {

      childProcess.stdout.off('data', dataListener);
    });
  }

  /**
   * Starts the FFmpeg process. Re-arms the close event latch so a reused instance can emit close again for its new process lifecycle.
   */
  public override start(commandLineArgs?: string[], callback?: StreamRequestCallback, errorHandler?: (errorMessage: string) => Promise<void> | void): void {

    this.hasEmittedClose = false;

    super.start(commandLineArgs, callback, errorHandler);
  }

  /**
   * Stops the FFmpeg process and performs cleanup. Subclasses override this to emit mode-specific events before calling super, which handles the shared
   * teardown and emits the "close" event.
   */
  protected override stopProcess(): void {

    // Call our parent to get started.
    super.stopProcess();

    // Signal that the process has ended. The close event must fire at most once per process lifecycle, no matter how many times we're stopped.
    this._isEnded = true;

    if(!this.hasEmittedClose) {

      this.hasEmittedClose = true;
      this.emit('close');
    }
  }

  /**
   * Stops the FFmpeg process and logs errors if specified.
   *
   * @param logErrors - If `true`, logs FFmpeg errors. Defaults to the internal process logging state.
   *
   * @example
   *
   * ```ts
   * process.stop();
   * ```
   */
  public override stop(logErrors = this.isLoggingErrors): void {

    const savedLogErrors = this.isLoggingErrors;

    // Flag whether we should log abnormal exits (e.g. being killed) or not.
    this.isLoggingErrors = logErrors;

    // Call our parent to finish the job.
    super.stop();

    // Restore our previous logging state.
    this.isLoggingErrors = savedLogErrors;
  }

  /**
   * Logs errors from FFmpeg process execution, handling known benign HKSV stream errors gracefully.
   *
   * @param exitCode - The exit code from the FFmpeg process.
   * @param signal   - The signal (if any) used to terminate the process.
   */
  protected override logFfmpegError(exitCode: Nullable<number>, signal: Nullable<NodeJS.Signals>): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // See if we know about this error.
    if(this.stderrLog.some(x => FFMPEG_KNOWN_HKSV_ERROR.test(x))) {

      this.log.error('FFmpeg ended unexpectedly due to issues processing the media stream. This error can be safely ignored - it will occur occasionally.');

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }
}
