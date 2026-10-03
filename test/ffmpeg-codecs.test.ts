/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ffmpeg-codecs.test.ts: Characterization tests for FFmpeg capability probing and host system detection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EOL } from 'node:os';
import type { FfmpegCodecs as FfmpegCodecsType } from '../src/lib/ffmpeg/codecs.js';
import type * as childProcess from 'node:child_process';
import type * as fs from 'node:fs';
import type * as os from 'node:os';
import type * as nodeProcess from 'node:process';

// Our mocked environment: the platform, CPU model, Raspberry Pi model file, and the responses to each command we're asked to execute.
type CommandResponse = { error?: NodeJS.ErrnoException, stdout?: string };

type MockEnv = {

  calls: { args: string[], command: string }[],
  cpuModel: string | undefined,
  modelFile: string | null,
  platform: string,
  respond: (command: string, args: string[]) => CommandResponse,
};

const env = vi.hoisted((): MockEnv => ({

  calls: [],
  cpuModel: 'Generic CPU',
  modelFile: null,
  platform: 'linux',
  respond: (): CommandResponse => ({ stdout: '' }),
}));

vi.mock('node:process', async (importOriginal) => {

  const actual = await importOriginal<typeof nodeProcess>();

  return { ...actual, get platform(): string {

    return env.platform;
  } };
});

vi.mock('node:os', async (importOriginal) => {

  const actual = await importOriginal<typeof os>();

  return { ...actual, cpus: (): { model: string }[] => (env.cpuModel === undefined) ? [] : [{ model: env.cpuModel }] };
});

vi.mock('node:fs', async (importOriginal) => {

  const actual = await importOriginal<typeof fs>();

  return { ...actual, readFileSync: (): string => {

    if(env.modelFile === null) {

      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }

    return env.modelFile;
  } };
});

vi.mock('node:child_process', async (importOriginal) => {

  const actual = await importOriginal<typeof childProcess>();

  return {

    ...actual,
    execFile: (command: string, args: string[], callback: (error: Error | null, result?: { stderr: string, stdout: string }) => void): void => {

      env.calls.push({ args, command });

      const { error, stdout } = env.respond(command, args);

      if(error) {

        callback(error);

        return;
      }

      callback(null, { stderr: '', stdout: stdout ?? '' });
    },
  };
});

// Representative FFmpeg output.
const VERSION_OUTPUT = 'ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers' + EOL + 'built with Apple clang' + EOL;

const CODECS_OUTPUT = [

  'Codecs:',
  ' D..... = Decoding supported',
  ' -------',
  ' DEV.LS h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (decoders: h264 h264_qsv H264_V4L2M2M ) (encoders: libx264 h264_qsv ' +
    'h264_videotoolbox )',
  ' DEV.L. hevc                 H.265 / HEVC (High Efficiency Video Coding) (decoders: hevc hevc_qsv )',
  ' DEA.L. aac                  AAC (Advanced Audio Coding) (decoders: aac aac_fixed libfdk_aac ) (encoders: aac aac_at libfdk_aac )',
  ' D.V.L. av1                  Alliance for Open Media AV1',
  '',
].join(EOL);

const HWACCELS_OUTPUT = [ 'Hardware acceleration methods:', 'videotoolbox', 'QSV', '' ].join(EOL);

// A logger that records what it's asked to log.
type MockFn = ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

function createLog(): { debug: MockFn, error: MockFn, info: MockFn, warn: MockFn } {

  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

// Load a fresh copy of the module so our mocked environment is picked up, and construct an instance.
async function createCodecs(log = createLog(), options: { ffmpegExec?: string, verbose?: boolean } = {}): Promise<FfmpegCodecsType> {

  const { FfmpegCodecs } = await import('../src/lib/ffmpeg/codecs.js');

  return new FfmpegCodecs({ log, ...options });
}

// The default command responder: a healthy FFmpeg installation.
function healthyResponder(command: string, args: string[]): { error?: NodeJS.ErrnoException, stdout?: string } {

  if(command === 'vcgencmd') {

    return { stdout: 'gpu=256M\n' };
  }

  if(args.includes('-version')) {

    return { stdout: VERSION_OUTPUT };
  }

  if(args.includes('-codecs')) {

    return { stdout: CODECS_OUTPUT };
  }

  if(args.includes('-hwaccels')) {

    return { stdout: HWACCELS_OUTPUT };
  }

  // Hardware acceleration validation runs.
  return { stdout: '' };
}

beforeEach(() => {

  vi.resetModules();

  env.calls = [];
  env.cpuModel = 'Generic CPU';
  env.modelFile = null;
  env.platform = 'linux';
  env.respond = healthyResponder;
});

afterEach(() => {

  vi.restoreAllMocks();
});

describe('FfmpegCodecs host detection', () => {

  it('defaults to a generic host with no CPU generation and no GPU memory', async () => {

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('generic');
    expect(codecs.cpuGeneration).toBe(0);
    expect(codecs.gpuMem).toBe(0);
    expect(codecs.ffmpegVersion).toBe('');
    expect(codecs.ffmpegExec).toBe('ffmpeg');
    expect(codecs.verbose).toBe(false);
  });

  it('detects Apple Silicon Macs and their CPU generation', async () => {

    env.platform = 'darwin';
    env.cpuModel = 'Apple M3 Pro';

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('macOS.Apple');
    expect(codecs.cpuGeneration).toBe(3);
  });

  it('reports generation 0 for unrecognized Apple CPU model strings', async () => {

    env.platform = 'darwin';
    env.cpuModel = 'Apple processor';

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('macOS.Apple');
    expect(codecs.cpuGeneration).toBe(0);
  });

  it('detects Intel Macs', async () => {

    env.platform = 'darwin';
    env.cpuModel = 'Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz';

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('macOS.Intel');
    expect(codecs.cpuGeneration).toBe(0);
  });

  it('detects a Raspberry Pi 4 from the device tree model', async () => {

    env.modelFile = 'Raspberry Pi 4 Model B Rev 1.4';

    expect((await createCodecs()).hostSystem).toBe('raspbian');
  });

  it('detects a Raspberry Pi Compute Module 4', async () => {

    env.modelFile = 'Raspberry Pi Compute Module 4 Rev 1.0';

    expect((await createCodecs()).hostSystem).toBe('raspbian');
  });

  it('does not treat other Raspberry Pi models as raspbian', async () => {

    env.modelFile = 'Raspberry Pi 5 Model B Rev 1.0';

    expect((await createCodecs()).hostSystem).toBe('generic');
  });

  it.each([

    [ 'Intel(R) Core(TM) i7-920 CPU @ 2.67GHz', 1 ],
    [ 'Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz', 8 ],
    [ 'Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz', 10 ],
    [ '12th Gen Intel(R) Core(TM) i5-12400', 12 ],
    [ 'Intel(R) Celeron(R) N5105 @ 2.00GHz', 0 ],
  ])('derives the Intel CPU generation from "%s"', async (model, generation) => {

    env.cpuModel = model;

    expect((await createCodecs()).cpuGeneration).toBe(generation);
  });

  it('degrades gracefully when no CPU information is available', async () => {

    env.cpuModel = undefined;

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('generic');
    expect(codecs.cpuGeneration).toBe(0);
  });

  it('ignores unsupported platforms', async () => {

    env.platform = 'win32';
    env.cpuModel = 'Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz';

    const codecs = await createCodecs();

    expect(codecs.hostSystem).toBe('generic');
    expect(codecs.cpuGeneration).toBe(0);
  });
});

describe('FfmpegCodecs probing', () => {

  it('parses the version, codecs, and hardware accelerators', async () => {

    const log = createLog();
    const codecs = await createCodecs(log, { ffmpegExec: '/opt/ffmpeg' });

    await expect(codecs.probe()).resolves.toBe(true);

    expect(codecs.ffmpegVersion).toBe('8.0.1');
    expect(log.info).toHaveBeenCalledWith('Using FFmpeg version: %s.', '8.0.1');

    expect(codecs.hasDecoder('h264', 'h264_qsv')).toBe(true);
    expect(codecs.hasDecoder('H264', 'h264_v4l2m2m')).toBe(true);
    expect(codecs.hasDecoder('hevc', 'hevc_qsv')).toBe(true);
    expect(codecs.hasDecoder('hevc', 'hevc_videotoolbox')).toBe(false);
    expect(codecs.hasDecoder('av1', 'av1_qsv')).toBe(false);
    expect(codecs.hasDecoder('vp9', 'vp9')).toBe(false);
    expect(codecs.hasEncoder('h264', 'H264_VIDEOTOOLBOX')).toBe(true);
    expect(codecs.hasEncoder('aac', 'aac_at')).toBe(true);
    expect(codecs.hasEncoder('aac', 'libfdk_aac')).toBe(true);
    expect(codecs.hasEncoder('hevc', 'hevc_qsv')).toBe(false);

    expect(codecs.hasHwAccel('videotoolbox')).toBe(true);
    expect(codecs.hasHwAccel('qsv')).toBe(true);
    expect(codecs.hasHwAccel('cuda')).toBe(false);

    // Every command uses our configured FFmpeg executable, and each hardware accelerator is validated with a test encode.
    expect(env.calls.map(call => call.command)).toEqual([ '/opt/ffmpeg', '/opt/ffmpeg', '/opt/ffmpeg', '/opt/ffmpeg', '/opt/ffmpeg' ]);
    expect(env.calls.map(call => call.args)).toEqual([

      [ '-hide_banner', '-version' ],
      [ '-hide_banner', '-codecs' ],
      [ '-hide_banner', '-hwaccels' ],
      [ '-hide_banner', '-hwaccel', 'videotoolbox', '-v', 'quiet', '-t', '1', '-f', 'lavfi', '-i', 'color=black:1920x1080', '-c:v', 'libx264', '-f', 'null', '-' ],
      [ '-hide_banner', '-hwaccel', 'qsv', '-v', 'quiet', '-t', '1', '-f', 'lavfi', '-i', 'color=black:1920x1080', '-c:v', 'libx264', '-f', 'null', '-' ],
    ]);
  });

  it('records an unknown version when the version string cannot be parsed', async () => {

    env.respond = (command, args): { stdout?: string } => args.includes('-version') ? { stdout: 'something unexpected' } : healthyResponder(command, args);

    const codecs = await createCodecs();

    await expect(codecs.probe()).resolves.toBe(true);
    expect(codecs.ffmpegVersion).toBe('unknown');
  });

  it('discards hardware accelerators that fail validation, logging only when verbose', async () => {

    const failValidation = (command: string, args: string[]): { error?: NodeJS.ErrnoException, stdout?: string } =>
      (args.includes('-hwaccel') && args.includes('qsv')) ? { error: Object.assign(new Error('Command failed'), { code: '1' }) } : healthyResponder(command, args);

    env.respond = failValidation;

    const quietLog = createLog();
    const quiet = await createCodecs(quietLog);

    await expect(quiet.probe()).resolves.toBe(true);
    expect(quiet.hasHwAccel('qsv')).toBe(false);
    expect(quiet.hasHwAccel('videotoolbox')).toBe(true);
    expect(quietLog.error).not.toHaveBeenCalled();

    const verboseLog = createLog();
    const verbose = await createCodecs(verboseLog, { verbose: true });

    await verbose.probe();
    expect(verboseLog.error).toHaveBeenCalledWith(
      'Hardware-accelerated decoding and encoding using %s will be unavailable: unable to successfully validate capabilities.', 'qsv');
  });

  it('fails when FFmpeg cannot be found', async () => {

    env.respond = (): { error: NodeJS.ErrnoException } => ({ error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) });

    const log = createLog();
    const codecs = await createCodecs(log);

    await expect(codecs.probe()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toBe("Unable to find '%s' in path: '%s'.");
    expect(log.error.mock.calls[0]?.[1]).toBe('ffmpeg');
    expect(env.calls).toHaveLength(1);
  });

  it('fails and explains when FFmpeg errors while probing codecs', async () => {

    env.respond = (command, args): { error?: NodeJS.ErrnoException, stdout?: string } =>
      args.includes('-codecs') ? { error: Object.assign(new Error('Segmentation fault.'), { code: '139' }) } : healthyResponder(command, args);

    const log = createLog();
    const codecs = await createCodecs(log);

    await expect(codecs.probe()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith('Error running %s: %s.', 'ffmpeg', 'Segmentation fault');
    expect(log.error).toHaveBeenCalledWith(
      "Unable to probe the capabilities of your Homebridge host without access to '%s'. Ensure that it is available in your path and correctly working.", 'ffmpeg');

    // We never get as far as probing hardware accelerators.
    expect(env.calls.some(call => call.args.includes('-hwaccels'))).toBe(false);
  });

  it('fails when the hardware accelerator listing cannot be retrieved', async () => {

    env.respond = (command, args): { error?: NodeJS.ErrnoException, stdout?: string } =>
      args.includes('-hwaccels') ? { error: Object.assign(new Error('boom'), { code: '1' }) } : healthyResponder(command, args);

    await expect((await createCodecs()).probe()).resolves.toBe(false);
  });

  it('probes Raspberry Pi GPU memory before probing FFmpeg', async () => {

    env.modelFile = 'Raspberry Pi 4 Model B Rev 1.4';

    const codecs = await createCodecs();

    await expect(codecs.probe()).resolves.toBe(true);
    expect(codecs.gpuMem).toBe(256);
    expect(env.calls[0]).toEqual({ args: [ 'get_mem', 'gpu' ], command: 'vcgencmd' });
  });

  it('treats unparseable Raspberry Pi GPU memory as zero', async () => {

    env.modelFile = 'Raspberry Pi 4 Model B Rev 1.4';
    env.respond = (command, args): { stdout?: string } => (command === 'vcgencmd') ? { stdout: 'error=1\n' } : healthyResponder(command, args);

    const codecs = await createCodecs();

    await codecs.probe();
    expect(codecs.gpuMem).toBe(0);
  });

  it('does not probe GPU memory on non-Raspberry Pi hosts', async () => {

    await (await createCodecs()).probe();

    expect(env.calls.some(call => call.command === 'vcgencmd')).toBe(false);
  });
});
