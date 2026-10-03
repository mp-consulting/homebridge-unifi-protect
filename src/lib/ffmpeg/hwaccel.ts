/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * hwaccel.ts: Host-specific hardware acceleration backends used to generate FFmpeg decoder, filter, and encoder arguments.
 */

/**
 * Host-specific FFmpeg hardware acceleration backends.
 *
 * Each supported host family (macOS VideoToolbox, Raspberry Pi, and generic hosts with optional Intel Quick Sync Video support) implements the
 * `HwAccelBackend` strategy interface. `FfmpegOptions` selects a backend once, at construction time, and delegates every platform-specific decision to it.
 *
 * @module
 */
import { AudioRecordingCodecType, H264Level, H264Profile, type Logging } from 'homebridge';
import type { FfmpegOptionsConfig, VideoEncoderOptions } from './options.js';
import type { FfmpegCodecs } from './codecs.js';
import type { HomebridgePluginLogging } from '../util.js';
import { RPI_GPU_MINIMUM } from './settings.js';

/**
 * The video codecs we know how to decode, after normalization.
 *
 * @category FFmpeg
 */
export type HwAccelVideoCodec = 'av1' | 'h264' | 'hevc';

/**
 * The context a hardware acceleration backend operates on. The `config` object is shared with `FfmpegOptions` and is mutated in place as hardware
 * capabilities are resolved.
 *
 * @category FFmpeg
 */
export interface HwAccelContext {

  codecSupport: FfmpegCodecs;
  config: FfmpegOptionsConfig;
  log: HomebridgePluginLogging | Logging;
}

/**
 * Strategy interface for host-specific hardware acceleration in FFmpeg.
 *
 * @category FFmpeg
 */
export interface HwAccelBackend {

  /**
   * Validates hardware-accelerated decoding for this host, updating `config.hardwareDecoding` as needed. Only invoked when hardware decoding was requested.
   *
   * @returns `false` if hardware acceleration configuration should stop entirely, `true` otherwise.
   */
  configureDecoding(): boolean;

  /**
   * Validates hardware-accelerated transcoding for this host, updating `config.hardwareDecoding` and `config.hardwareTranscoding` as needed. Only invoked when
   * hardware transcoding was requested.
   *
   * @returns An informational message describing the hardware acceleration in use, or an empty string.
   */
  configureTranscoding(): string;

  /**
   * Returns the audio encoder arguments for this host.
   */
  audioEncoder(codec: AudioRecordingCodecType | undefined): string[];

  /**
   * Returns the hardware decoder arguments for a given codec. Only invoked when hardware decoding is enabled.
   */
  decoderArgs(codec: HwAccelVideoCodec): string[];

  /**
   * Returns the arguments needed to initialize a hardware device context when encoding in hardware without decoding in hardware.
   */
  deviceInitArgs(): string[];

  /**
   * Returns the filters needed to move frames from the GPU to system memory.
   */
  downloadFilters(): string[];

  /**
   * Returns the filters needed to move frames from system memory to the GPU.
   */
  uploadFilters(): string[];

  /**
   * Returns the scale filters for this host, applied after any hardware transfer filters.
   *
   * @param options - Video encoder options.
   * @param swScale - The default software scale filter.
   */
  scaleFilters(options: VideoEncoderOptions, swScale: string): string[];

  /**
   * Returns the hardware encoder arguments for livestreaming.
   *
   * @param options            - Video encoder options.
   * @param videoFilters       - The assembled video filter chain.
   * @param adjustedMaxBitrate - The maximum bitrate, in kilobits per second, including any headroom.
   */
  streamEncoderArgs(options: VideoEncoderOptions, videoFilters: string, adjustedMaxBitrate: number): string[];

  /**
   * Indicates whether HomeKit Secure Video event recording can use the same (potentially hardware-accelerated) encoder used for livestreaming.
   */
  readonly hksvUsesStreamEncoder: boolean;

  /**
   * The maximum pixel count supported by the hardware encoder when hardware transcoding is enabled, or `Infinity` if not limited.
   */
  readonly maxTranscodePixels: number;
}

/**
 * Converts a HomeKit H.264 level enum value to the corresponding FFmpeg string or numeric representation.
 *
 * @param level        - The H.264 level to translate.
 * @param numeric      - Optional. If `true`, returns the numeric representation (e.g., "31"). Otherwise returns the standard string format (e.g., "3.1").
 *
 * @returns The FFmpeg-compatible H.264 level string or numeric value.
 *
 * @category FFmpeg
 */
export function h264LevelArg(level: H264Level, numeric = false): string {

  switch(level) {

    case H264Level.LEVEL3_1:

      return numeric ? '31' : '3.1';

    case H264Level.LEVEL3_2:

      return numeric ? '32' : '3.2';

    case H264Level.LEVEL4_0:

      return numeric ? '40' : '4.0';

    default:

      return numeric ? '31' : '3.1';
  }
}

/**
 * Converts a HomeKit H.264 profile enum value to the corresponding FFmpeg string or numeric representation.
 *
 * @param profile - The H.264 profile to translate.
 * @param numeric - Optional. If `true`, returns the numeric representation (e.g., "100"). Otherwise returns the standard string format (e.g., "high").
 *
 * @returns The FFmpeg-compatible H.264 profile string or numeric value.
 *
 * @category FFmpeg
 */
export function h264ProfileArg(profile: H264Profile, numeric = false): string {

  switch(profile) {

    case H264Profile.BASELINE:

      return numeric ? '66' : 'baseline';

    case H264Profile.HIGH:

      return numeric ? '100' : 'high';

    case H264Profile.MAIN:

      return numeric ? '77' : 'main';

    default:

      return numeric ? '77' : 'main';
  }
}

/**
 * Describes which hardware acceleration features are currently enabled, for use in log messages.
 *
 * @param config - The hardware acceleration flags to describe.
 *
 * @returns A human-readable list of the enabled hardware acceleration categories.
 *
 * @category FFmpeg
 */
export function hwAccelCategories(config: { hardwareDecoding: boolean, hardwareTranscoding: boolean }): string {

  const categories = [];

  if(config.hardwareDecoding) {

    categories.push('decoding');
  }

  if(config.hardwareTranscoding) {

    categories.push('⛭︎ transcoding');
  }

  return categories.join(' and ');
}

/**
 * Shared behavior for hardware acceleration backends.
 */
abstract class BaseHwAccelBackend implements HwAccelBackend {

  protected readonly ctx: HwAccelContext;
  public readonly hksvUsesStreamEncoder: boolean = true;
  public readonly maxTranscodePixels: number = Infinity;

  constructor(ctx: HwAccelContext) {

    this.ctx = ctx;
  }

  public abstract configureDecoding(): boolean;
  public abstract configureTranscoding(): string;
  public abstract decoderArgs(codec: HwAccelVideoCodec): string[];
  public abstract deviceInitArgs(): string[];
  public abstract downloadFilters(): string[];
  public abstract uploadFilters(): string[];
  public abstract scaleFilters(options: VideoEncoderOptions, swScale: string): string[];
  public abstract streamEncoderArgs(options: VideoEncoderOptions, videoFilters: string, adjustedMaxBitrate: number): string[];

  // Default to libfdk_aac for audio encoding.
  public audioEncoder(codec: AudioRecordingCodecType | undefined): string[] {

    return this.defaultAudioEncoder(codec);
  }

  // Utility to return which hardware acceleration features are currently available to us.
  protected accelCategories(): string {

    return hwAccelCategories(this.ctx.config);
  }

  // Utility function to return a default audio encoder codec.
  protected defaultAudioEncoder(codec: AudioRecordingCodecType | undefined): string[] {

    const audioOptions = [];

    if(this.ctx.codecSupport.hasEncoder('aac', 'libfdk_aac')) {

      // Default to libfdk_aac since FFmpeg doesn't natively support AAC-ELD. We use the following options by default:
      //
      // -codec:a libfdk_aac           Use the libfdk_aac encoder.
      // -afterburner 1                Increases audio quality at the expense of needing a little bit more computational power in libfdk_aac.
      audioOptions.push('-codec:a', 'libfdk_aac', '-afterburner', '1');

      switch(codec) {

        case AudioRecordingCodecType.AAC_ELD:

          break;

        case AudioRecordingCodecType.AAC_LC:
        default:

          audioOptions.push('-vbr', '4');

          break;
      }
    }

    return audioOptions;
  }

  // -r framerate                        Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware
  //                                    pipeline.
  protected frameRateArgs(options: VideoEncoderOptions): string[] {

    return (options.fps !== options.inputFps) ? [ '-r', options.fps.toString() ] : [];
  }

  // Utility function to check that we have a specific encoder codec available to us.
  protected validateEncoder(codec: string): boolean {

    if(!this.ctx.codecSupport.hasEncoder('h264', codec)) {

      this.ctx.log.error('Unable to enable hardware-accelerated transcoding. Your video processor does not have support for the ' + codec + ' encoder. ' +
        'Using software transcoding instead.');

      this.ctx.config.hardwareTranscoding = false;

      return false;
    }

    return true;
  }

  // Utility function to check that we have a specific hardware accelerator available to us.
  protected validateHwAccel(accel: string): boolean {

    if(!this.ctx.codecSupport.hasHwAccel(accel)) {

      this.ctx.log.error('Unable to enable hardware-accelerated decoding. Your video processor does not have support for the ' + accel +
        ' hardware accelerator. Using software decoding instead.');

      this.ctx.config.hardwareDecoding = false;

      return false;
    }

    return true;
  }

  // Indicates whether we're running FFmpeg 8.x, which unlocks several hardware pipeline capabilities.
  protected get isFfmpeg8(): boolean {

    return this.ctx.codecSupport.ffmpegVersion.startsWith('8.');
  }
}

/**
 * macOS hardware acceleration using VideoToolbox and AudioToolbox, for both Apple Silicon and Intel-based Macs.
 *
 * @category FFmpeg
 */
export class VideoToolboxBackend extends BaseHwAccelBackend {

  private readonly appleSilicon: boolean;

  constructor(ctx: HwAccelContext, appleSilicon: boolean) {

    super(ctx);

    this.appleSilicon = appleSilicon;
  }

  public configureDecoding(): boolean {

    // Verify that we have hardware-accelerated decoding available to us.
    this.validateHwAccel('videotoolbox');

    return true;
  }

  public configureTranscoding(): string {

    // Verify that we have the hardware encoder available to us.
    this.validateEncoder('h264_videotoolbox');

    // Validate that we have access to the AudioToolbox AAC encoder.
    if(!this.ctx.codecSupport.hasEncoder('aac', 'aac_at')) {

      this.ctx.log.error('Your video processor does not have support for the native macOS AAC encoder, aac_at. Will attempt to use libfdk_aac instead.');
    }

    return '';
  }

  public override audioEncoder(codec: AudioRecordingCodecType | undefined): string[] {

    // If we don't have audiotoolbox available, let's default back to libfdk_aac.
    if(!this.ctx.codecSupport.hasEncoder('aac', 'aac_at')) {

      return this.defaultAudioEncoder(codec);
    }

    // aac_at is the macOS audio encoder API. We use the following options:
    //
    // -codec:a aac_at               Use the aac_at encoder on macOS.
    // -aac_at_mode cvbr             Use the constrained variable bitrate setting to allow the encoder to optimize audio within the requested bitrates.
    const encoderOptions = [

      '-codec:a', 'aac_at',
    ];

    switch(codec) {

      case AudioRecordingCodecType.AAC_ELD:

        encoderOptions.push('-aac_at_mode', 'cbr');

        break;

      case AudioRecordingCodecType.AAC_LC:
      default:

        encoderOptions.push('-aac_at_mode', 'vbr');
        encoderOptions.push('-q:a', '2');

        break;
    }

    return encoderOptions;
  }

  public decoderArgs(): string[] {

    // h264_videotoolbox is the macOS hardware decoder and encoder API. We use the following options for decoding video:
    //
    // -hwaccel videotoolbox           Select Video Toolbox for hardware-accelerated H.264 decoding.
    return [

      '-hwaccel', 'videotoolbox',
      ...(this.isFfmpeg8 ? [ '-hwaccel_output_format', 'videotoolbox_vld' ] : []),
    ];
  }

  public deviceInitArgs(): string[] {

    // Unfortunately, versions of FFmpeg prior to 8.0 don't properly support VideoToolbox use cases like this.
    if(!this.isFfmpeg8) {

      return [];
    }

    // Initialize VideoToolbox hardware context and assign it a name for use in filter chains.
    //
    // -init_hw_device               Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
    // -filter_hw_device             Specify the hardware accelerator to be used with our video filter pipeline.
    return [ '-init_hw_device', 'videotoolbox=hw', '-filter_hw_device', 'hw' ];
  }

  public downloadFilters(): string[] {

    // FFmpeg 8.x on macOS requires explicit download and format conversion when moving from VideoToolbox to software.
    return this.isFfmpeg8 ? [ 'hwdownload', 'format=nv12' ] : [];
  }

  public uploadFilters(): string[] {

    // FFmpeg 8.x on macOS requires explicit upload when moving from software decoding to VideoToolbox encoding.
    return this.isFfmpeg8 ? [ 'hwupload' ] : [];
  }

  public scaleFilters(options: VideoEncoderOptions, swScale: string): string[] {

    if(this.isFfmpeg8 && options.hardwareTranscoding) {

      // On macOS with FFmpeg 8.x, we can use the VideoToolbox scaler (scale_vt) which provides hardware-accelerated scaling. This is significantly more
      // efficient than software scaling and can handle higher throughput with lower CPU usage. Prior to FFmpeg 8.0, this would break under a variety of
      // scenarios and was unreliable.
      return [ 'scale_vt=-2:min(ih\\, ' + options.height.toString() + ')' ];
    }

    // Fall back to software scaling with explicit pixel format conversion.
    return [ swScale ];
  }

  public streamEncoderArgs(options: VideoEncoderOptions, videoFilters: string, adjustedMaxBitrate: number): string[] {

    // h264_videotoolbox is the macOS hardware encoder API. We use the following options:
    //
    // -codec:v                      Specify the macOS hardware encoder, h264_videotoolbox.
    // -allow_sw 1                   Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
    //                               This allows us to scale when we get multiple streaming requests simultaneously and consume all the available encode
    //                               engines.
    // -realtime 1                   We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
    // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v 0                    We override what HomeKit requests for the H.264 profile level on macOS when we're using hardware-accelerated
    //                               transcoding because the hardware encoder is particular about how to use levels. Setting it to 0 allows the encoder to
    //                               decide for itself.
    // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -noautoscale                  Don't attempt to scale the video stream automatically.
    // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect
    //                               ratios and ensuring our final dimensions are a power of two.
    // -b:v                          Average bitrate that's being requested by HomeKit. On Intel-based Macs, we can't use a quality constraint and allow for
    //                               more optimization of the bitrate due to hardware / API limitations.
    // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                               livestreaming experience.
    // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
    // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware
    //                               pipeline.
    const encoderOptions = [ '-codec:v', 'h264_videotoolbox', '-allow_sw', '1', '-realtime', '1', '-profile:v', h264ProfileArg(options.profile),
      '-level:v', '0', '-bf', '0', '-noautoscale', '-filter:v', videoFilters ];

    if(!this.appleSilicon) {

      encoderOptions.push('-b:v', options.bitrate.toString() + 'k', '-g:v', (options.fps * options.idrInterval).toString(),
        '-bufsize', (2 * options.bitrate).toString() + 'k', '-maxrate', adjustedMaxBitrate.toString() + 'k', ...this.frameRateArgs(options));

      return encoderOptions;
    }

    encoderOptions.push('-g:v', (options.fps * options.idrInterval).toString(), '-bufsize', (2 * options.bitrate).toString() + 'k',
      '-maxrate', adjustedMaxBitrate.toString() + 'k', ...this.frameRateArgs(options));

    if(options.smartQuality) {

      // -q:v 90                     Use a fixed quality scale of 90, to allow videotoolbox the ability to vary bitrates to achieve the visual quality we
      //                             want, constrained by our maximum bitrate. This is an Apple Silicon-specific feature.
      encoderOptions.push('-q:v', '90');
    } else {

      // -b:v                        Average bitrate that's being requested by HomeKit.
      encoderOptions.push('-b:v', options.bitrate.toString() + 'k');
    }

    return encoderOptions;
  }
}

/**
 * Raspberry Pi hardware acceleration using the V4L2 memory-to-memory encoder.
 *
 * @category FFmpeg
 */
export class RaspberryPiBackend extends BaseHwAccelBackend {

  // Raspberry Pi struggles with hardware-accelerated HKSV event recording due to issues in the FFmpeg codec driver, currently. We hope this improves over
  // time and can offer it to Pi users, or develop a workaround. For now, we default to libx264.
  public override readonly hksvUsesStreamEncoder = false;

  // For constrained environments like Raspberry Pi, when hardware transcoding has been selected for a camera, we limit the available source streams to no
  // more than 1080p. In practice, that means that devices like the G4 Pro can't use their highest quality stream for transcoding due to the limitations of
  // the Raspberry Pi GPU that cannot support higher pixel counts.
  public override readonly maxTranscodePixels = 1920 * 1080;

  public configureDecoding(): boolean {

    // If it's less than the minimum hardware GPU memory we need on an Raspberry Pi, we revert back to our default decoder.
    if(this.ctx.codecSupport.gpuMem < RPI_GPU_MINIMUM) {

      this.ctx.log.info('Disabling hardware-accelerated %s. Adjust the GPU memory configuration on your Raspberry Pi to at least %s MB to enable it.',
        this.accelCategories(), RPI_GPU_MINIMUM);

      this.ctx.config.hardwareDecoding = false;
      this.ctx.config.hardwareTranscoding = false;

      return false;
    }

    // Verify that we have the hardware decoder available to us. Unfortunately, as of FFmpeg 7, it seems that hardware decoding is flaky, at best, on
    // Raspberry Pi, so we use software decoding.
    this.ctx.config.hardwareDecoding = false;

    return true;
  }

  public configureTranscoding(): string {

    // Verify that we have the hardware encoder available to us.
    this.validateEncoder('h264_v4l2m2m');

    return 'Raspberry Pi hardware acceleration will be used for livestreaming. ' +
      'HomeKit Secure Video recordings are not supported by the hardware encoder and will use software transcoding instead';
  }

  public decoderArgs(): string[] {

    // h264_v4l2m2m is the preferred Raspberry Pi hardware decoder codec, but the decoder is broken in FFmpeg 7, unfortunately.
    return [];
  }

  public deviceInitArgs(): string[] {

    // We don't need to initialize anything on Raspbian.
    return [];
  }

  public downloadFilters(): string[] {

    // We don't need to download anything on Raspbian.
    return [];
  }

  public uploadFilters(): string[] {

    // The Raspberry Pi hardware encoder prefers being fed the ubiquitous yuv420p.
    return [ 'format=yuv420p' ];
  }

  public scaleFilters(_options: VideoEncoderOptions, swScale: string): string[] {

    // Raspberry Pi uses the standard software scaler. Hardware scaling capabilities vary by model, so we use the reliable software path.
    return [ swScale ];
  }

  public streamEncoderArgs(options: VideoEncoderOptions, videoFilters: string, adjustedMaxBitrate: number): string[] {

    // h264_v4l2m2m is the preferred interface to the Raspberry Pi hardware encoder API. We use the following options:
    //
    // -codec:v                      Specify the Raspberry Pi hardware encoder, h264_v4l2m2m.
    // -noautoscale                  Don't attempt to scale the video stream automatically.
    // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect
    //                               ratios and ensuring our final dimensions are a power of two.
    // -b:v                          Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization
    //                               of the bitrate due to v4l2m2m limitations.
    // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                               livestreaming experience.
    // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
    // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware
    //                               pipeline.
    return [ '-codec:v', 'h264_v4l2m2m', '-profile:v', h264ProfileArg(options.profile, true), '-bf', '0', '-noautoscale',
      '-reset_timestamps', '1', '-filter:v', videoFilters, '-b:v', options.bitrate.toString() + 'k',
      '-g:v', (options.fps * options.idrInterval).toString(), '-bufsize', (2 * options.bitrate).toString() + 'k',
      '-maxrate', adjustedMaxBitrate.toString() + 'k', ...this.frameRateArgs(options) ];
  }
}

/**
 * Generic host hardware acceleration. Hardware acceleration is only available when Intel Quick Sync Video is detected; otherwise we use software processing.
 *
 * @category FFmpeg
 */
export class QuickSyncBackend extends BaseHwAccelBackend {

  // Intel QSV decoder to codec mapping.
  private static readonly qsvDecoder: Record<HwAccelVideoCodec, string> = {

    'av1': 'av1_qsv',
    'h264': 'h264_qsv',
    'hevc': 'hevc_qsv',
  };

  public configureDecoding(): boolean {

    // Back to software decoding unless we're on a known system that always supports hardware decoding.
    this.ctx.config.hardwareDecoding = false;

    return true;
  }

  public configureTranscoding(): string {

    const codecSupport = this.ctx.codecSupport;

    // Let's see if we have Intel QuickSync hardware decoding available to us.
    if(codecSupport.hasHwAccel('qsv') && codecSupport.hasDecoder('h264', 'h264_qsv') && codecSupport.hasEncoder('h264', 'h264_qsv') &&
      codecSupport.hasDecoder('hevc', 'hevc_qsv')) {

      this.ctx.config.hardwareDecoding = true;

      return 'Intel Quick Sync Video';
    }

    // Back to software encoding.
    this.ctx.config.hardwareDecoding = false;
    this.ctx.config.hardwareTranscoding = false;

    return '';
  }

  public decoderArgs(codec: HwAccelVideoCodec): string[] {

    // h264_qsv is the Intel Quick Sync Video hardware encoder and decoder.
    //
    // -hwaccel qsv                    Select Quick Sync Video to enable hardware-accelerated H.264 decoding.
    // -codec:v X_qsv                  Select the Quick Sync Video codec for hardware-accelerated AV1, H.264, or HEVC processing. AV1 decoding isn't
    //                                 available before 11th generation Intel CPUs.
    return ((codec === 'av1') && (this.ctx.codecSupport.cpuGeneration < 11)) ? [] : [

      '-hwaccel', 'qsv',
      '-hwaccel_output_format', 'qsv',
      '-codec:v', QuickSyncBackend.qsvDecoder[codec],
    ];
  }

  public deviceInitArgs(): string[] {

    // Initialize Intel Quick Sync Video hardware context.
    //
    // -init_hw_device               Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
    // -filter_hw_device             Specify the hardware accelerator to be used with our video filter pipeline.
    return [ '-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw' ];
  }

  public downloadFilters(): string[] {

    // Other platforms typically just need a simple download operation.
    return [ 'hwdownload' ];
  }

  public uploadFilters(): string[] {

    // We need to upload frames from system memory to the GPU for hardware encoding.
    return [ 'hwupload' ];
  }

  public scaleFilters(options: VideoEncoderOptions, swScale: string): string[] {

    if(!options.hardwareTranscoding) {

      return [ swScale ];
    }

    // When using Intel Quick Sync Video, we execute GPU-accelerated operations using the vpp_qsv post-processing filter.
    //
    // format=same                   Set the output pixel format to the same as the input, since it's already in the GPU.
    // w=...:h...                    Scale the video to the size that's being requested while respecting aspect ratios.
    return [ 'vpp_qsv=' + [

      'format=same',
      'w=min(iw\\, (iw / ih) * ' + options.height.toString() + ')',
      'h=min(ih\\, ' + options.height.toString() + ')',
    ].join(':') ];
  }

  public streamEncoderArgs(options: VideoEncoderOptions, videoFilters: string, adjustedMaxBitrate: number): string[] {

    // h264_qsv is the Intel Quick Sync Video hardware encoder API. We use the following options:
    //
    // -codec:v                      Specify the Intel Quick Sync Video hardware encoder, h264_qsv.
    // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v 0                    We override what HomeKit requests for the H.264 profile level when we're using hardware-accelerated transcoding because
    //                               the hardware encoder will determine which levels to use. Setting it to 0 allows the encoder to decide for itself.
    // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -noautoscale                  Don't attempt to scale the video stream automatically.
    // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect
    //                               ratios and ensuring our final dimensions are a power of two.
    // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                               livestreaming experience.
    // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
    // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware
    //                               pipeline.
    const encoderOptions = [ '-codec:v', 'h264_qsv', '-profile:v', h264ProfileArg(options.profile), '-level:v', '0', '-bf', '0', '-noautoscale',
      '-filter:v', videoFilters, '-g:v', (options.fps * options.idrInterval).toString(),
      '-bufsize', (2 * options.bitrate).toString() + 'k', '-maxrate', adjustedMaxBitrate.toString() + 'k', ...this.frameRateArgs(options) ];

    if(options.smartQuality) {

      // -global_quality 20          Use a global quality setting of 20, to allow QSV the ability to vary bitrates to achieve the visual quality we want,
      //                             constrained by our maximum bitrate. This leverages a QSV-specific feature known as intelligent constant quality.
      encoderOptions.push('-global_quality', '20');
    } else {

      // -b:v                        Average bitrate that's being requested by HomeKit.
      encoderOptions.push('-b:v', options.bitrate.toString() + 'k');
    }

    return encoderOptions;
  }
}

/**
 * Selects the hardware acceleration backend appropriate for the host system reported by our codec support.
 *
 * @param ctx - The hardware acceleration context.
 *
 * @returns The hardware acceleration backend for this host.
 *
 * @category FFmpeg
 */
export function createHwAccelBackend(ctx: HwAccelContext): HwAccelBackend {

  switch(ctx.codecSupport.hostSystem) {

    case 'macOS.Apple':

      return new VideoToolboxBackend(ctx, true);

    case 'macOS.Intel':

      return new VideoToolboxBackend(ctx, false);

    case 'raspbian':

      return new RaspberryPiBackend(ctx);

    default:

      return new QuickSyncBackend(ctx);
  }
}
