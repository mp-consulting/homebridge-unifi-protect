/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * options.ts: FFmpeg decoder and encoder options with hardware-accelerated codec support where available.
 */

/**
 * Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.
 *
 * This module defines interfaces and classes for specifying, adapting, and generating FFmpeg command-line arguments tailored to the host system's capabilities.
 * It automates the selection of codecs, pixel formats, hardware encoders/decoders, and streaming profiles for maximum compatibility and performance.
 *
 * Key features:
 *
 * - Encapsulates all FFmpeg transcoding and streaming options (including bitrate, resolution, framerate, H.264 profiles/levels, and quality optimizations).
 * - Detects and configures hardware-accelerated encoding and decoding (macOS VideoToolbox, Intel Quick Sync Video, and Raspberry Pi 4), falling back to
 *   software processing when required.
 * - Dynamically generates the appropriate FFmpeg command-line arguments for livestreaming, HomeKit Secure Video (HKSV) event recording, and crop filters.
 * - Provides strong TypeScript types and interfaces for reliable integration and extensibility in Homebridge.
 *
 * This module is intended for plugin authors and advanced users who need precise, robust control over FFmpeg processing pipelines, with platform-aware
 * optimizations and safe fallbacks.
 *
 * @module
 */
import { AudioRecordingCodecType, type H264Level, type H264Profile, type Logging } from 'homebridge';
import { type HwAccelBackend, type HwAccelVideoCodec, createHwAccelBackend, h264LevelArg, h264ProfileArg, hwAccelCategories } from './hwaccel.js';
import type { FfmpegCodecs } from './codecs.js';
import { HOMEKIT_STREAMING_HEADROOM } from './settings.js';
import type { HomebridgePluginLogging } from '../util.js';

/**
 * Configuration options for `FfmpegOptions`, defining transcoding, decoding, logging, and hardware acceleration settings.
 *
 * @property codecSupport         - FFmpeg codec capabilities and hardware support.
 * @property crop                 - Optional. Cropping rectangle for output video.
 * @property debug                - Optional. Enable debug logging.
 * @property hardwareDecoding     - Enable hardware-accelerated video decoding if available.
 * @property hardwareTranscoding  - Enable hardware-accelerated video encoding if available.
 * @property log                  - Logging interface for output and errors.
 * @property name                 - Function returning the name or label for this options set.
 *
 * @remarks The `hardwareDecoding` and `hardwareTranscoding` flags are bidirectional. On input, they express the caller's desired hardware acceleration state.
 * During `FfmpegOptions` construction, the flags are resolved against the host's actual capabilities and the config object is mutated in place to reflect what
 * is available. After construction, these flags represent the resolved state...`hardwareDecoding` or `hardwareTranscoding` may be set to `false` if the
 * required codecs or accelerators are absent, or `hardwareDecoding` may be set to `true` if Intel Quick Sync Video is detected even when not explicitly
 * requested.
 *
 * @example
 *
 * ```ts
 * const optionsConfig: FfmpegOptionsConfig = {
 *
 *   codecSupport: ffmpegCodecs,
 *   crop: { width: 1, height: 1, x: 0, y: 0 },
 *   debug: false,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   log,
 *   name: () => "Camera"
 * };
 * ```
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export interface FfmpegOptionsConfig {

  codecSupport: FfmpegCodecs;
  crop?: {

    height: number,
    width: number,
    x: number,
    y: number,
  };
  debug?: boolean;
  hardwareDecoding: boolean;
  hardwareTranscoding: boolean;
  log: HomebridgePluginLogging | Logging;
  name: () => string;
}

/**
 * Options used for configuring video encoding in FFmpeg operations.
 *
 * These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.
 *
 * @property codec               - Optional. Audio codec to encode (`AudioRecordingCodecType.AAC_ELD` or `AudioRecordingCodecType.AAC_LC`). Defaults to
 *                                 `AudioRecordingCodecType.AAC_ELD`.
 *
 * @example
 *
 * ```ts
 * const encoderOptions: AudioEncoderOptions = {
 *
 *   codec: AudioRecordingCodecType.AAC_ELD
 * };
 *
 * // Use with FfmpegOptions for transcoding.
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 * const args = ffmpegOpts.audioEncoder(encoderOptions);
 * ```
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export interface AudioEncoderOptions {

  codec?: AudioRecordingCodecType;
}

/**
 * Options used for configuring video encoding in FFmpeg operations.
 *
 * These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.
 *
 * @property bitrate             - Target video bitrate, in kilobits per second.
 * @property fps                 - Target output frames per second.
 * @property hardwareDecoding    - Optional. If `true`, encoder options will account for hardware decoding (primarily for Intel QSV scenarios). Defaults to
 *                                 `true`.
 * @property height              - Output video height, in pixels.
 * @property idrInterval         - Interval (in seconds) between keyframes (IDR frames).
 * @property inputFps            - Input (source) frames per second.
 * @property level               - H.264 profile level for output.
 * @property profile             - H.264 profile for output.
 * @property smartQuality        - Optional and applicable only when not using hardware acceleration. If `true`, enables smart quality and variable bitrate
 *                                 optimizations. Defaults to `true`.
 * @property width               - Output video width, in pixels.
 *
 * @example
 *
 * ```ts
 * const encoderOptions: VideoEncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   smartQuality: true,
 *   width: 1920
 * };
 *
 * // Use with FfmpegOptions for transcoding or streaming.
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 * const args = ffmpegOpts.streamEncoder(encoderOptions);
 * ```
 *
 * @see FfmpegOptions
 * @see {@link https://ffmpeg.org/ffmpeg-codecs.html | FFmpeg Codecs Documentation}
 *
 * @category FFmpeg
 */
export interface VideoEncoderOptions {

  bitrate: number;
  fps: number;
  hardwareDecoding?: boolean;
  hardwareTranscoding?: boolean;
  height: number;
  idrInterval: number;
  inputFps: number;
  level: H264Level;
  profile: H264Profile;
  smartQuality?: boolean;
  width: number;
}

/**
 * Provides Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.
 *
 * This class generates and adapts FFmpeg command-line arguments for livestreaming and event recording, optimizing for system hardware and codec availability.
 *
 * @example
 *
 * ```ts
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 *
 * // Generate video encoder arguments for streaming.
 * const encoderOptions: VideoEncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   smartQuality: true,
 *   width: 1920
 * };
 * const args = ffmpegOpts.streamEncoder(encoderOptions);
 *
 * // Generate crop filter string, if cropping is enabled.
 * const crop = ffmpegOpts.cropFilter;
 * ```
 *
 * @see AudioEncoderOptions
 * @see VideoEncoderOptions
 * @see FfmpegCodecs
 * @see {@link https://ffmpeg.org/ffmpeg.html | FFmpeg Documentation}
 *
 * @category FFmpeg
 */
export class FfmpegOptions {

  /**
   * FFmpeg codec and hardware capabilities for the current host.
   *
   */
  public readonly codecSupport: FfmpegCodecs;

  /**
   * The configuration options used to initialize this instance.
   */
  public readonly config: FfmpegOptionsConfig;

  /**
   * Indicates if debug logging is enabled.
   */
  public readonly debug: boolean;

  /**
   * Logging interface for output and errors.
   */
  public readonly log: HomebridgePluginLogging | Logging;

  /**
   * Function returning the name for this options instance to be used for logging.
   */
  public readonly name: () => string;

  /**
   * The hardware acceleration backend for the host system, selected once at construction time.
   */
  private readonly hwAccel: HwAccelBackend;

  /**
   * Creates an instance of Homebridge FFmpeg encoding and decoding options.
   *
   * @param options          - FFmpeg options configuration.
   *
   * @example
   *
   * ```ts
   * const ffmpegOpts = new FfmpegOptions(optionsConfig);
   * ```
   */
  constructor(options: FfmpegOptionsConfig) {

    this.codecSupport = options.codecSupport;
    this.config = options;
    this.debug = options.debug ?? false;
    this.log = options.log;
    this.name = options.name;

    // Select the hardware acceleration backend for our host system.
    this.hwAccel = createHwAccelBackend({ codecSupport: this.codecSupport, config: this.config, log: this.log });

    // Configure our hardware acceleration support.
    this.configureHwAccel();
  }

  /**
   * Determines and configures hardware-accelerated video decoding and transcoding for the host system.
   *
   * This internal method checks for the availability of hardware codecs and accelerators based on the host platform and updates FFmpeg options to use the best
   * available hardware or falls back to software processing when necessary. It logs warnings or errors if required codecs or hardware acceleration are
   * unavailable.
   *
   * This method is called automatically by the `FfmpegOptions` constructor and is not intended to be called directly.
   *
   * @returns `true` if hardware-accelerated transcoding is enabled after configuration, otherwise `false`.
   *
   * @see FfmpegCodecs
   * @see FfmpegOptions
   * @see HwAccelBackend
   */
  private configureHwAccel(): boolean {

    let logMessage = '';

    // Hardware-accelerated decoding is enabled by default, where supported. Let's validate the decoder options for our host. A backend can halt any further
    // hardware acceleration configuration entirely (e.g. a Raspberry Pi without enough GPU memory).
    if(this.config.hardwareDecoding && !this.hwAccel.configureDecoding()) {

      return false;
    }

    // If we've enabled hardware-accelerated transcoding, let's validate the encoder options for our host.
    if(this.config.hardwareTranscoding) {

      logMessage = this.hwAccel.configureTranscoding();
    }

    // Inform the user.
    if(this.config.hardwareDecoding || this.config.hardwareTranscoding) {

      this.log.info('⚡️ Hardware-accelerated ' + hwAccelCategories(this.config) + ' enabled' + (logMessage.length ? ': ' + logMessage : '') + '.');
    }

    return this.config.hardwareTranscoding;
  }

  /**
   * Determines the required hardware transfer filters based on the decoding and encoding configuration.
   *
   * This method manages the transition between software and hardware processing contexts. When video data needs to move between the CPU and GPU for processing,
   * we provide the appropriate FFmpeg filters to handle that transfer efficiently.
   *
   * @param options - Video encoder options including hardware decoding and transcoding state.
   * @returns Array of filter strings for hardware upload or download operations.
   */
  private getHardwareTransferFilters(options: { hardwareDecoding?: boolean, hardwareTranscoding?: boolean }): string[] {

    // We need to handle four possible state transitions between decoding and encoding.
    //
    // 1. Software decode -> Software encode: No transfer needed, stay in software.
    // 2. Software decode -> Hardware encode: Need hwupload to move data to GPU.
    // 3. Hardware decode -> Software encode: Need hwdownload to move data to CPU.
    // 4. Hardware decode -> Hardware encode: No transfer needed, stay in hardware.
    if(!options.hardwareDecoding && options.hardwareTranscoding) {

      return this.hwAccel.uploadFilters();
    }

    if(options.hardwareDecoding && !options.hardwareTranscoding) {

      return this.hwAccel.downloadFilters();
    }

    return [];
  }

  /**
   * Gets hardware device initialization options for encoders that need them.
   *
   * When we're using hardware encoding without hardware decoding, we need to initialize the hardware device context explicitly. This method provides the
   * platform-specific initialization arguments required by FFmpeg.
   *
   * @param options - Video encoder options.
   * @returns Array of FFmpeg arguments for hardware device initialization.
   */
  private getHardwareDeviceInit(options: VideoEncoderOptions): string[] {

    // Only initialize hardware device if we're encoding with hardware but not decoding with it. When decoding with hardware, the device context is already
    // initialized by the decoder.
    if(!options.hardwareDecoding && options.hardwareTranscoding) {

      return this.hwAccel.deviceInitArgs();
    }

    return [];
  }

  /**
   * Returns the audio encoder arguments to use when transcoding.
   *
   * @param options  - Optional. The encoder options to use for generating FFmpeg arguments.
   * @returns Array of FFmpeg command-line arguments for audio encoding.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.audioEncoder();
   * ```
   */
  public audioEncoder(options: AudioEncoderOptions = {}): string[] {

    // Default our codec to AAC_ELD unless specified.
    options = { codec: AudioRecordingCodecType.AAC_ELD, ...options };

    return this.hwAccel.audioEncoder(options.codec);
  }

  /**
   * Returns the audio decoder to use when decoding.
   *
   * @returns The FFmpeg audio decoder string.
   */
  public readonly audioDecoder: string = 'libfdk_aac';

  /**
   * Returns the video decoder arguments to use for decoding video.
   *
   * @param codec            - Optional. Codec to decode (`"av1"`, `"h264"` (default), or `"hevc"`).
   * @returns Array of FFmpeg command-line arguments for video decoding or an empty array if the codec isn't supported.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.videoDecoder("h264");
   * ```
   */
  public videoDecoder(codec = 'h264'): string[] {

    let normalizedCodec: HwAccelVideoCodec;

    switch(codec.toLowerCase()) {

      case 'av1':

        normalizedCodec = 'av1';

        break;

      case 'h264':

        normalizedCodec = 'h264';

        break;

      case 'h265':
      case 'hevc':

        normalizedCodec = 'hevc';

        break;

      default:

        // If it's unknown to us, we bail out.
        return [];
    }

    // Default to no special decoder options for inbound streams. If we've enabled hardware-accelerated decoding, let's select decoder options accordingly.
    return this.config.hardwareDecoding ? this.hwAccel.decoderArgs(normalizedCodec) : [];
  }

  /**
   * Returns the platform-appropriate FFmpeg video filters needed to transfer hardware-decoded frames to system memory. When hardware decoding is active,
   * decoded frames may reside on the GPU and require explicit download before CPU-based filters (crop, scale, format conversion) can operate on them. Returns
   * an empty array when hardware decoding is disabled or when the platform handles the transfer implicitly (e.g. Raspberry Pi).
   *
   * @returns An array of FFmpeg filter strings to prepend to a video filter chain, or an empty array if no transfer is needed.
   */
  public get hardwareDownloadFilters(): string[] {

    return this.getHardwareTransferFilters({ hardwareDecoding: this.config.hardwareDecoding, hardwareTranscoding: false });
  }

  /**
   * Returns the FFmpeg crop filter string, or a default no-op filter if cropping is disabled.
   *
   * @returns The crop filter string for FFmpeg.
   */
  public get cropFilter(): string {

    // If we haven't enabled cropping, tell the crop filter to do nothing.
    if(!this.config.crop) {

      return 'crop=w=iw*100:h=ih*100:x=iw*0:y=ih*0';
    }

    // Generate our crop filter based on what the user has configured.
    return 'crop=' + [

      'w=iw*' + this.config.crop.width.toString(),
      'h=ih*' + this.config.crop.height.toString(),
      'x=iw*' + this.config.crop.x.toString(),
      'y=ih*' + this.config.crop.y.toString(),
    ].join(':');
  }

  /**
   * Generate the appropriate scale filter for the current platform. This method returns platform-specific scale filters to leverage hardware acceleration
   * capabilities where available.
   */
  private getScaleFilter(options: VideoEncoderOptions): string[] {

    // Our default software scaler.
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two. Hardware backends may substitute an accelerated scaler (scale_vt on macOS, vpp_qsv on Intel QSV).
    const swScale = 'scale=-2:min(ih\\, ' + options.height.toString() + ')' + ':in_range=auto:out_range=auto';

    // Add any required hardware transfer filters first. This ensures we're in the correct memory context before scaling.
    return [ ...this.getHardwareTransferFilters(options), ...this.hwAccel.scaleFilters(options, swScale) ];
  }

  /**
   * Generates the default set of FFmpeg video encoder arguments for software transcoding using libx264.
   *
   * This method builds command-line options for the FFmpeg libx264 encoder based on the provided encoder options, including bitrate, H.264 profile and level,
   * pixel format, frame rate, buffer size, and optional smart quality settings. It is used internally when hardware-accelerated transcoding is not enabled or
   * supported.
   *
   * @param options            - The encoder options to use for generating FFmpeg arguments.
   *
   * @returns An array of FFmpeg command-line arguments for software video encoding.
   *
   * @see VideoEncoderOptions
   */
  private defaultVideoEncoderOptions(options: VideoEncoderOptions): string[] {

    const videoFilters = [];

    // fps=                              Use the fps filter to provide the frame rate requested by HomeKit. We only need to apply this filter if our input and
    //                                   output frame rates aren't already identical.
    const fpsFilter = [ 'fps=' + options.fps.toString() ];

    // Build our pixel-level filters. We need to handle potential hardware downloads and format conversions.
    const pixelFilters = [];

    // Add any required hardware transfer filters. This handles downloading from GPU if we were hardware decoding.
    pixelFilters.push(...this.getHardwareTransferFilters(options));

    // Set our FFmpeg pixel-level filters:
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two.
    pixelFilters.push('scale=-2:min(ih\\, ' + options.height.toString() + '):in_range=auto:out_range=auto');

    // Let's assemble our filter collection. If we're reducing our framerate, we want to frontload the fps filter so the downstream filters need to do less
    // work. If we're increasing our framerate, we want to do pixel operations on the minimal set of source frames that we need, since we're just going to
    // duplicate them.
    if(options.fps < options.inputFps) {

      videoFilters.push(...fpsFilter, ...pixelFilters);
    } else {

      videoFilters.push(...pixelFilters, ...(options.fps > options.inputFps ? fpsFilter : []));
    }

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -codec:v libx264                  Use the excellent libx264 H.264 encoder.
    // -preset veryfast                  Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -profile:v                        Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v                          Use the H.264 profile level that HomeKit is requesting when encoding.
    // -noautoscale                      Don't attempt to scale the video stream automatically.
    // -bf 0                             Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -filter:v                         Set the pixel format and scale the video to the size we want while respecting aspect ratios and ensuring our final
    //                                   dimensions are a power of two.
    // -g:v                              Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                                   livestreaming experience.
    // -bufsize size                     This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate                  The maximum bitrate tolerance, used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to
    //                                   allow encoders some variation in order to maximize quality while honoring bandwidth constraints.
    const encoderOptions = [

      '-codec:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', h264ProfileArg(options.profile),
      '-level:v', h264LevelArg(options.level),
      '-noautoscale',
      '-bf', '0',
      '-filter:v', videoFilters.join(', '),
      '-g:v', (options.fps * options.idrInterval).toString(),
      '-bufsize', (2 * options.bitrate).toString() + 'k',
      '-maxrate', (options.bitrate + (options.smartQuality ? HOMEKIT_STREAMING_HEADROOM : 0)).toString() + 'k',
    ];

    // Using libx264's constant rate factor mode produces generally better results across the board. We use a capped CRF approach, allowing libx264 to make
    // intelligent choices about how to adjust bitrate to achieve a certain quality level depending on the complexity of the scene being encoded, but
    // constraining it to a maximum bitrate to stay within the bandwidth constraints HomeKit is requesting.
    if(options.smartQuality) {

      // -crf 20                         Use a constant rate factor of 20, to allow libx264 the ability to vary bitrates to achieve the visual quality we
      //                                 want, constrained by our maximum bitrate.
      encoderOptions.push('-crf', '20');
    } else {

      // For recording HKSV, we really want to maintain a tight rein on bitrate and don't want to freelance with perceived quality for two reasons - HKSV is
      // very latency sensitive and it's also very particular about bitrates and the specific format of the stream it receives. The second reason is that HKSV
      // typically requests bitrates of around 2000kbps, which results in a reasonably high quality recording, as opposed to the typical 2-300kbps that
      // livestreaming from the Home app itself generates. Those lower bitrates in livestreaming really benefit from the magic that using a good CRF value can
      // produce in libx264.
      encoderOptions.push('-b:v', options.bitrate.toString() + 'k');
    }

    return encoderOptions;
  }

  /**
   * Returns the video encoder options to use for HomeKit Secure Video (HKSV) event recording.
   *
   * @param options          - Encoder options to use.
   * @returns Array of FFmpeg command-line arguments for video encoding.
   */
  public recordEncoder(options: VideoEncoderOptions): string[] {

    // We always disable smart quality when recording due to HomeKit's strict requirements here.
    options.smartQuality = false;

    // Generally, we default to using the same encoding options we use to transcode livestreams, unless we have platform-specific quirks we need to address,
    // such as where we can have hardware-accelerated transcoded livestreaming, but not hardware-accelerated HKSV event recording. The other noteworthy aspect
    // here is that HKSV is quite specific in what it wants, and isn't very tolerant of creative license in how you may choose to alter bitrate to address
    // quality. When we call our encoders, we also let them know we don't want any additional quality optimizations when transcoding HKSV events.
    return this.hwAccel.hksvUsesStreamEncoder ? this.streamEncoder(options) : this.defaultVideoEncoderOptions(options);
  }

  /**
   * Returns the video encoder options to use when transcoding for livestreaming.
   *
   * @param options          - Encoder options to use.
   * @returns Array of FFmpeg command-line arguments for video encoding.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.streamEncoder(encoderOptions);
   * ```
   */
  public streamEncoder(options: VideoEncoderOptions): string[] {

    // Default hardware decoding and smart quality to true unless specified.
    options = { hardwareDecoding: true, hardwareTranscoding: this.config.hardwareTranscoding, smartQuality: true, ...options };

    // Disable hardware acceleration if we haven't detected it.
    if(!this.config.hardwareDecoding) {

      options.hardwareDecoding = false;
    }

    if(!this.config.hardwareTranscoding) {

      options.hardwareTranscoding = false;
    }

    // If we aren't hardware-accelerated, we default to libx264.
    if(!options.hardwareTranscoding) {

      return this.defaultVideoEncoderOptions(options);
    }

    // If we've enabled hardware-accelerated transcoding, let's select encoder options accordingly.
    //
    // We begin by adjusting the maximum bitrate tolerance used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to allow
    // encoders some variation in order to maximize quality while honoring bandwidth constraints.
    const adjustedMaxBitrate = options.bitrate + (options.smartQuality ? HOMEKIT_STREAMING_HEADROOM : 0);

    // Build our pixel filter chain. We conditionally include the crop filter if configured, then apply platform-specific scaling which handles any necessary
    // hardware transfers internally.
    //
    // crop                              Crop filter options, if requested.
    // scale=...                         Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions
    //                                   are a power of two. This also handles hardware transfers as needed.
    const videoFilters = [ ...(this.config.crop ? [ this.cropFilter ] : []), ...this.getScaleFilter(options) ];

    // Hardware device initialization comes first, if needed, followed by our host-specific encoder options.
    return [ ...this.getHardwareDeviceInit(options), ...this.hwAccel.streamEncoderArgs(options, videoFilters.join(', '), adjustedMaxBitrate) ];
  }

  /**
   * Returns the maximum pixel count supported by a specific hardware encoder on the host system, or `Infinity` if not limited.
   *
   * @returns Maximum supported pixel count.
   */
  public get hostSystemMaxPixels(): number {

    return this.config.hardwareTranscoding ? this.hwAccel.maxTranscodePixels : Infinity;
  }
}
