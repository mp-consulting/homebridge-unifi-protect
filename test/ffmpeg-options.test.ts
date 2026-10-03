/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ffmpeg-options.test.ts: Characterization tests for FfmpegOptions argument generation across host systems and hardware acceleration configurations.
 */
import { AudioRecordingCodecType, H264Level, H264Profile } from 'homebridge';
import { FfmpegOptions, type FfmpegOptionsConfig, type VideoEncoderOptions } from '../src/lib/ffmpeg/options.js';
import { describe, expect, it, vi } from 'vitest';
import type { FfmpegCodecs } from '../src/lib/ffmpeg/codecs.js';

// A host profile describing what our stubbed codec support object reports.
interface HostProfile {

  cpuGeneration?: number;
  decoders?: string[];
  encoders?: string[];
  gpuMem?: number;
  hostSystem: string;
  hwAccels?: string[];
}

// The codec capabilities a typical host exposes, keyed as "codec:implementation".
const MAC_ENCODERS = [ 'h264:h264_videotoolbox', 'aac:aac_at', 'aac:libfdk_aac' ];
const QSV_DECODERS = [ 'h264:h264_qsv', 'hevc:hevc_qsv', 'av1:av1_qsv' ];

// The host systems we characterize.
const HOSTS = {

  'generic': { encoders: [ 'aac:libfdk_aac' ], hostSystem: 'generic' },
  'generic-no-fdk': { hostSystem: 'generic' },
  'generic-qsv-gen10': { cpuGeneration: 10, decoders: QSV_DECODERS, encoders: [ 'h264:h264_qsv', 'aac:libfdk_aac' ], hostSystem: 'generic', hwAccels: [ 'qsv' ] },
  'generic-qsv-gen12': { cpuGeneration: 12, decoders: QSV_DECODERS, encoders: [ 'h264:h264_qsv', 'aac:libfdk_aac' ], hostSystem: 'generic', hwAccels: [ 'qsv' ] },
  'generic-qsv-no-hevc': { cpuGeneration: 12, decoders: [ 'h264:h264_qsv' ], encoders: [ 'h264:h264_qsv' ], hostSystem: 'generic', hwAccels: [ 'qsv' ] },
  'macOS.Apple': { cpuGeneration: 2, encoders: MAC_ENCODERS, hostSystem: 'macOS.Apple', hwAccels: [ 'videotoolbox' ] },
  'macOS.Apple-no-aac_at': { encoders: [ 'h264:h264_videotoolbox', 'aac:libfdk_aac' ], hostSystem: 'macOS.Apple', hwAccels: [ 'videotoolbox' ] },
  'macOS.Apple-no-vt': { encoders: [ 'aac:aac_at' ], hostSystem: 'macOS.Apple' },
  'macOS.Intel': { encoders: MAC_ENCODERS, hostSystem: 'macOS.Intel', hwAccels: [ 'videotoolbox' ] },
  'raspbian': { encoders: [ 'h264:h264_v4l2m2m', 'aac:libfdk_aac' ], gpuMem: 256, hostSystem: 'raspbian' },
  'raspbian-lowmem': { encoders: [ 'h264:h264_v4l2m2m', 'aac:libfdk_aac' ], gpuMem: 64, hostSystem: 'raspbian' },
  'raspbian-no-v4l2': { encoders: [ 'aac:libfdk_aac' ], gpuMem: 256, hostSystem: 'raspbian' },
} satisfies Record<string, HostProfile>;

// Build a stand-in for FfmpegCodecs that reports the capabilities of a given host profile.
function stubCodecs(host: HostProfile, ffmpegVersion: string): FfmpegCodecs {

  const has = (list: string[] | undefined, codec: string, impl: string): boolean => (list ?? []).includes(codec.toLowerCase() + ':' + impl.toLowerCase());

  return {

    cpuGeneration: host.cpuGeneration ?? 0,
    ffmpegExec: 'ffmpeg',
    ffmpegVersion,
    gpuMem: host.gpuMem ?? 0,
    hasDecoder: (codec: string, decoder: string): boolean => has(host.decoders, codec, decoder),
    hasEncoder: (codec: string, encoder: string): boolean => has(host.encoders, codec, encoder),
    hasHwAccel: (accel: string): boolean => (host.hwAccels ?? []).includes(accel.toLowerCase()),
    hostSystem: host.hostSystem,
    verbose: false,
  } as unknown as FfmpegCodecs;
}

// Create an FfmpegOptions instance along with the log calls made during construction.
function createOptions(host: HostProfile, ffmpegVersion: string, hardwareDecoding: boolean, hardwareTranscoding: boolean,
  crop?: FfmpegOptionsConfig['crop']): { logs: unknown[][], opts: FfmpegOptions } {

  const logs: unknown[][] = [];
  const record = (level: string) => (...args: unknown[]): void => void logs.push([ level, ...args ]);

  const log = { debug: vi.fn(record('debug')), error: vi.fn(record('error')), info: vi.fn(record('info')), warn: vi.fn(record('warn')) };

  const opts = new FfmpegOptions({

    codecSupport: stubCodecs(host, ffmpegVersion),
    ...(crop ? { crop } : {}),
    debug: false,
    hardwareDecoding,
    hardwareTranscoding,
    log: log,
    name: (): string => 'Test Camera',
  });

  return { logs, opts };
}

// The set of encoder requests we exercise for each configuration.
const ENCODER_REQUESTS = {

  '1080p-high-30to30': { bitrate: 3000, fps: 30, height: 1080, idrInterval: 4, inputFps: 30, level: H264Level.LEVEL4_0, profile: H264Profile.HIGH, width: 1920 },
  '720p-main-30to15': { bitrate: 1000, fps: 15, height: 720, idrInterval: 2, inputFps: 30, level: H264Level.LEVEL3_1, profile: H264Profile.MAIN, width: 1280 },
  '360p-baseline-15to30': { bitrate: 300, fps: 30, height: 360, idrInterval: 1, inputFps: 15, level: H264Level.LEVEL3_2, profile: H264Profile.BASELINE,
    width: 640 },
  '480p-nosmart-nohwdec': { bitrate: 500, fps: 24, hardwareDecoding: false, height: 480, idrInterval: 4, inputFps: 24, level: H264Level.LEVEL3_1,
    profile: H264Profile.MAIN, smartQuality: false, width: 640 },
  '1440p-hwtrans-off': { bitrate: 2000, fps: 30, hardwareTranscoding: false, height: 1440, idrInterval: 4, inputFps: 25, level: H264Level.LEVEL4_0,
    profile: H264Profile.HIGH, width: 1920 },
} satisfies Record<string, VideoEncoderOptions>;

// Capture every public output of an FfmpegOptions instance.
function characterize(opts: FfmpegOptions, logs: unknown[][]): Record<string, unknown> {

  const streamEncoder: Record<string, string[]> = {};
  const recordEncoder: Record<string, string[]> = {};

  for(const [ name, request ] of Object.entries(ENCODER_REQUESTS)) {

    streamEncoder[name] = opts.streamEncoder({ ...request });
    recordEncoder[name] = opts.recordEncoder({ ...request });
  }

  return {

    audioDecoder: opts.audioDecoder,
    audioEncoder: {

      default: opts.audioEncoder(),
      eld: opts.audioEncoder({ codec: AudioRecordingCodecType.AAC_ELD }),
      lc: opts.audioEncoder({ codec: AudioRecordingCodecType.AAC_LC }),
    },
    cropFilter: opts.cropFilter,
    hardwareDecoding: opts.config.hardwareDecoding,
    hardwareDownloadFilters: opts.hardwareDownloadFilters,
    hardwareTranscoding: opts.config.hardwareTranscoding,
    hostSystemMaxPixels: opts.hostSystemMaxPixels,
    logs,
    recordEncoder,
    streamEncoder,
    videoDecoder: {

      av1: opts.videoDecoder('av1'),
      default: opts.videoDecoder(),
      h264: opts.videoDecoder('H264'),
      h265: opts.videoDecoder('h265'),
      hevc: opts.videoDecoder('hevc'),
      vp9: opts.videoDecoder('vp9'),
    },
  };
}

describe('FfmpegOptions characterization', () => {

  for(const [ hostName, host ] of Object.entries(HOSTS)) {

    describe(hostName, () => {

      for(const ffmpegVersion of [ '7.1.1', '8.0' ]) {

        for(const hardwareDecoding of [ false, true ]) {

          for(const hardwareTranscoding of [ false, true ]) {

            it('ffmpeg ' + ffmpegVersion + ', hwdec=' + String(hardwareDecoding) + ', hwenc=' + String(hardwareTranscoding), () => {

              const { logs, opts } = createOptions(host, ffmpegVersion, hardwareDecoding, hardwareTranscoding);

              expect(characterize(opts, logs)).toMatchSnapshot();
            });
          }
        }
      }

      it('with cropping enabled', () => {

        const { logs, opts } = createOptions(host, '8.0', true, true, { height: 0.5, width: 0.75, x: 0.1, y: 0.2 });

        expect(characterize(opts, logs)).toMatchSnapshot();
      });
    });
  }
});

describe('FfmpegOptions behavior', () => {

  it('recordEncoder always disables smart quality on the caller-provided options', () => {

    const { opts } = createOptions(HOSTS.generic, '8.0', false, false);
    const request = { ...ENCODER_REQUESTS['1080p-high-30to30'], smartQuality: true };

    opts.recordEncoder(request);

    expect(request.smartQuality).toBe(false);
  });

  it('uses libx264 with a capped CRF for software streaming', () => {

    const { opts } = createOptions(HOSTS.generic, '8.0', false, false);

    expect(opts.streamEncoder({ ...ENCODER_REQUESTS['720p-main-30to15'] })).toEqual([

      '-codec:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level:v', '3.1', '-noautoscale', '-bf', '0',
      '-filter:v', 'fps=15, scale=-2:min(ih\\, 720):in_range=auto:out_range=auto', '-g:v', '30', '-bufsize', '2000k', '-maxrate', '1064k', '-crf', '20',
    ]);
  });

  it('uses VideoToolbox with hardware upload and scale_vt on Apple Silicon with FFmpeg 8', () => {

    const { opts } = createOptions(HOSTS['macOS.Apple'], '8.0', true, true);

    expect(opts.streamEncoder({ ...ENCODER_REQUESTS['480p-nosmart-nohwdec'] })).toEqual([

      '-init_hw_device', 'videotoolbox=hw', '-filter_hw_device', 'hw', '-codec:v', 'h264_videotoolbox', '-allow_sw', '1', '-realtime', '1',
      '-profile:v', 'main', '-level:v', '0', '-bf', '0', '-noautoscale', '-filter:v', 'hwupload, scale_vt=-2:min(ih\\, 480)', '-g:v', '96',
      '-bufsize', '1000k', '-maxrate', '500k', '-b:v', '500k',
    ]);
  });

  it('enables hardware decoding when Intel Quick Sync Video is detected', () => {

    const { opts } = createOptions(HOSTS['generic-qsv-gen12'], '8.0', false, true);

    expect(opts.config.hardwareDecoding).toBe(true);
    expect(opts.videoDecoder('hevc')).toEqual([ '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-codec:v', 'hevc_qsv' ]);
  });

  it('limits Raspberry Pi hardware transcoding to 1080p sources', () => {

    expect(createOptions(HOSTS.raspbian, '8.0', false, true).opts.hostSystemMaxPixels).toBe(1920 * 1080);
    expect(createOptions(HOSTS.raspbian, '8.0', false, false).opts.hostSystemMaxPixels).toBe(Infinity);
  });
});
