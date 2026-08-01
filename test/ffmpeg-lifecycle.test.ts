/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ffmpeg-lifecycle.test.ts: Regression tests for FFmpeg process lifecycle, fMP4 output parsing, and RTP demuxer teardown behavior.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, type CameraRecordingConfiguration } from 'homebridge';
import { type EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BOX_HEADER_SIZE } from '../src/lib/ffmpeg/fmp4.js';
import { FfmpegExec } from '../src/lib/ffmpeg/exec.js';
import { FfmpegLivestreamProcess } from '../src/lib/ffmpeg/record.js';
import { FfmpegProcess } from '../src/lib/ffmpeg/process.js';
import { FfmpegStreamingProcess, type HomebridgeStreamingDelegate } from '../src/lib/ffmpeg/stream.js';
import type { FfmpegOptions } from '../src/lib/ffmpeg/options.js';
import type { PassThrough } from 'node:stream';
import { RtpDemuxer } from '../src/lib/ffmpeg/rtp.js';
import type childProcess from 'node:child_process';

// The shape of the fake child process our mocked spawn() returns. These tests exercise process lifecycle logic without requiring a real FFmpeg binary.
type FakeChild = EventEmitter & { killed: boolean, kill: (signal?: string) => boolean, stderr: PassThrough, stdin: PassThrough, stdout: PassThrough };

// Track every fake child our mocked spawn() hands out, so tests can drive process events directly.
const spawnState = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('node:child_process', async (importOriginal) => {

  const actual = await importOriginal<typeof childProcess>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');

  // A minimal stand-in for a spawned FFmpeg process: real streams for stdio, event emission for lifecycle, and a kill() that only flags itself.
  class FakeChildProcess extends EventEmitter {

    public killed = false;
    public stderr = new PassThrough();
    public stdin = new PassThrough();
    public stdout = new PassThrough();

    public kill(): boolean {

      this.killed = true;

      return true;
    }
  }

  return {

    ...actual,
    spawn: (): unknown => {

      const child = new FakeChildProcess();

      spawnState.children.push(child);

      return child;
    },
  };
});

// Retrieve the most recently spawned fake child.
function lastChild(): FakeChild {

  return spawnState.children[spawnState.children.length - 1] as FakeChild;
}

// Minimal FfmpegOptions stand-in covering everything the process classes touch.
function createOptions(): FfmpegOptions {

  return {

    audioEncoder: (): string[] => [ '-codec:a', 'aac' ],
    codecSupport: { ffmpegExec: 'ffmpeg', ffmpegVersion: '8.0', verbose: false },
    config: { debug: false, hardwareDecoding: false, hardwareTranscoding: false },
    debug: false,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    name: (): string => 'test-camera',
    recordEncoder: (): string[] => [ '-codec:v', 'libx264' ],
    videoDecoder: (): string[] => [],
  } as unknown as FfmpegOptions;
}

// Minimal HomeKit recording configuration for the fMP4 process classes.
const recordingConfig = {

  audioCodec: { audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_32, type: AudioRecordingCodecType.AAC_LC },
  videoCodec: { parameters: { bitRate: 2000, level: 0, profile: 0 }, resolution: [ 1280, 720, 30 ] },
} as unknown as CameraRecordingConfiguration;

// Construct an ISO BMFF box: a 32-bit big-endian size, a four-character type code, and the payload.
function box(type: string, payload: Buffer): Buffer {

  const header = Buffer.alloc(BOX_HEADER_SIZE);

  header.writeUInt32BE(BOX_HEADER_SIZE + payload.length, 0);
  header.write(type, 4, 'ascii');

  return Buffer.concat([ header, payload ]);
}

// Create a started livestream process along with its fake child.
function createLivestream(options = createOptions()): { child: FakeChild, proc: FfmpegLivestreamProcess } {

  const proc = new FfmpegLivestreamProcess(options, recordingConfig, { enableAudio: false, url: 'rtsp://127.0.0.1/test' });

  proc.start();

  return { child: lastChild(), proc };
}

describe('FfmpegExec', () => {

  it('resolves null when the process fails to spawn', async () => {

    const exec = new FfmpegExec(createOptions(), [ '-version' ], false);
    const resultPromise = exec.exec();
    const child = lastChild();

    // A failed spawn emits error (and close) but never exit.
    child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT', path: 'ffmpeg' }));

    await expect(resultPromise).resolves.toBeNull();
  });

  it('resolves with the process result on a normal exit', async () => {

    const exec = new FfmpegExec(createOptions(), [ '-version' ], false);
    const resultPromise = exec.exec();
    const child = lastChild();

    child.stdout.emit('data', Buffer.from('ffmpeg output'));
    child.emit('exit', 0, null);

    const result = await resultPromise;

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout.toString()).toBe('ffmpeg output');
  });
});

describe('FfmpegLivestreamProcess box parsing', () => {

  it('accumulates the init segment and emits media segments', () => {

    const { child, proc } = createLivestream();
    const segments: Buffer[] = [];

    proc.on('segment', (segment: Buffer) => segments.push(segment));

    const ftyp = box('ftyp', Buffer.from('iso5'));
    const moov = box('moov', Buffer.alloc(16, 1));
    const moof = box('moof', Buffer.alloc(8, 2));
    const mdat = box('mdat', Buffer.alloc(4, 3));

    child.stdout.emit('data', Buffer.concat([ ftyp, moov, moof, mdat ]));

    expect(proc.initSegment).toEqual(Buffer.concat([ ftyp, moov ]));
    expect(segments).toEqual([ moof, mdat ]);

    proc.stop();
    child.kill();
    child.emit('exit', null, null);
  });

  it('treats a box size below the header size as fatal stream corruption', () => {

    const options = createOptions();
    const { child, proc } = createLivestream(options);
    const segments: Buffer[] = [];

    proc.on('segment', (segment: Buffer) => segments.push(segment));

    // A zero-size box can never advance the parser: without the guard, the data handler loops forever.
    const corrupt = Buffer.alloc(BOX_HEADER_SIZE);

    corrupt.writeUInt32BE(0, 0);
    corrupt.write('free', 4, 'ascii');

    child.stdout.emit('data', corrupt);

    expect(vi.mocked(options.log.error).mock.calls.some(call => String(call[0]).includes('Invalid fMP4 box size'))).toBe(true);
    expect(child.killed).toBe(true);

    // The parser must be detached - subsequent output is ignored.
    child.stdout.emit('data', Buffer.concat([ box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(4)), box('moof', Buffer.alloc(4)) ]));
    expect(segments).toEqual([]);

    child.emit('exit', null, null);
  });

  it('resets init segment state when a reused instance is restarted', () => {

    const { child, proc } = createLivestream();
    const firstInit = Buffer.concat([ box('ftyp', Buffer.from('old!')), box('moov', Buffer.alloc(4, 1)) ]);

    child.stdout.emit('data', Buffer.concat([ firstInit, box('moof', Buffer.alloc(4, 2)) ]));
    expect(proc.initSegment).toEqual(firstInit);

    // End the first process and restart the same instance, as the livestream watchdog does.
    proc.stop();
    child.kill();
    child.emit('exit', null, null);
    proc.start();

    const restartChild = lastChild();
    const segments: Buffer[] = [];

    proc.on('segment', (segment: Buffer) => segments.push(segment));

    // The new process's ftyp and moov must be captured as the init segment, not emitted as media segments or shadowed by stale init data.
    const secondFtyp = box('ftyp', Buffer.from('new!'));
    const secondMoov = box('moov', Buffer.alloc(4, 9));

    child.stdout.emit('data', box('moof', Buffer.alloc(4, 5)));
    restartChild.stdout.emit('data', Buffer.concat([ secondFtyp, secondMoov ]));
    expect(segments).toEqual([]);
    expect(proc.initSegment).toBeNull();

    const secondMoof = box('moof', Buffer.alloc(4, 6));

    restartChild.stdout.emit('data', secondMoof);
    expect(proc.initSegment).toEqual(Buffer.concat([ secondFtyp, secondMoov ]));
    expect(segments).toEqual([ secondMoof ]);

    proc.stop();
    restartChild.kill();
    restartChild.emit('exit', null, null);
  });

  it('emits close at most once per process lifecycle', () => {

    const { child, proc } = createLivestream();
    let closeCount = 0;

    proc.on('close', () => closeCount++);

    proc.stop();
    child.kill();
    child.emit('exit', null, null);
    proc.stop();

    expect(closeCount).toBe(1);

    // A restarted instance must be able to emit close again for its new process.
    proc.start();

    const restartChild = lastChild();

    proc.stop();
    restartChild.kill();
    restartChild.emit('exit', null, null);

    expect(closeCount).toBe(2);
  });
});

describe('FfmpegProcess lifecycle', () => {

  it('does not let a superseded process exit clobber a newly started one', () => {

    const proc = new FfmpegProcess(createOptions(), [ '-i', 'test' ]);

    proc.start();

    const firstChild = lastChild();

    // Restart while the first process is still winding down.
    proc.start();

    const secondChild = lastChild();

    expect(secondChild).not.toBe(firstChild);

    firstChild.kill();
    firstChild.emit('exit', null, null);

    // The late exit of the old process must not null the reference to the new one.
    expect(proc.stdout).toBe(secondChild.stdout);

    proc.stop();
    secondChild.emit('exit', null, null);
    expect(proc.stdout).toBeNull();
  });

  it('does not arm the kill timer when stopping an already-exited process', () => {

    const proc = new FfmpegProcess(createOptions(), [ '-i', 'test' ]);

    proc.start();

    const child = lastChild();

    child.kill();
    child.emit('exit', null, null);

    // The process has exited - stop() must not arm a SIGKILL timer against nothing.
    proc.stop();
    expect((proc as unknown as { ffmpegTimeout?: NodeJS.Timeout }).ffmpegTimeout).toBeUndefined();
  });
});

describe('RtpDemuxer teardown', () => {

  it('makes close() idempotent', async () => {

    const options = createOptions();
    const demuxer = new RtpDemuxer('ipv4', 0, 0, 0, options.log);

    await once(demuxer.socket, 'listening');

    expect(demuxer.isRunning).toBe(true);
    demuxer.close();
    expect(demuxer.isRunning).toBe(false);

    // A second close on an already-closed socket must not throw and abort the caller's teardown.
    expect(() => demuxer.close()).not.toThrow();
  });

  it('tears down heartbeat state on a socket error and survives a subsequent close', async () => {

    const options = createOptions();
    const demuxer = new RtpDemuxer('ipv4', 0, 0, 0, options.log);

    await once(demuxer.socket, 'listening');

    demuxer.socket.emit('error', new Error('simulated network error'));

    expect(demuxer.isRunning).toBe(false);
    expect((demuxer as unknown as { heartbeatTimer?: NodeJS.Timeout }).heartbeatTimer).toBeUndefined();
    expect((demuxer as unknown as { heartbeatMsg?: Buffer }).heartbeatMsg).toBeUndefined();

    // Session teardown closing the demuxer after the error must not throw.
    expect(() => demuxer.close()).not.toThrow();
  });

  it('guards the heartbeat callback against a closed socket', async () => {

    const options = createOptions();
    const demuxer = new RtpDemuxer('ipv4', 0, 0, 0, options.log);

    await once(demuxer.socket, 'listening');

    demuxer.close();

    // Simulate a stale heartbeat armed against the closed socket - firing it must not throw out of the timer callback.
    vi.useFakeTimers();

    try {

      (demuxer as unknown as { heartbeatMsg?: Buffer }).heartbeatMsg = Buffer.alloc(1);
      (demuxer as unknown as { heartbeat: (port: number) => void }).heartbeat(45000);

      expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    } finally {

      vi.useRealTimers();
    }
  });
});

describe('FfmpegStreamingProcess socket cleanup', () => {

  // Create a streaming delegate mock with the hooks the process invokes during teardown.
  function createDelegate(): HomebridgeStreamingDelegate {

    return {

      controller: { forceStopStreamingSession: vi.fn() },
      stopStream: vi.fn(),
    } as unknown as HomebridgeStreamingDelegate;
  }

  it('closes the stream-health socket and clears the health timeout on stop', async () => {

    const proc = new FfmpegStreamingProcess(createDelegate(), 'session-1', createOptions(), [ '-i', 'test' ], { addressVersion: 'ipv4', port: 0 });
    const child = lastChild();
    const internals = proc as unknown as { socket?: EventEmitter, streamTimeout?: NodeJS.Timeout };
    const socket = internals.socket;

    expect(socket).toBeDefined();
    await once(socket as EventEmitter, 'listening');

    const socketClosed = once(socket as EventEmitter, 'close');

    proc.stop();

    await socketClosed;
    expect(internals.socket).toBeUndefined();
    expect(internals.streamTimeout).toBeUndefined();

    child.emit('exit', null, null);
  });

  it('closes the stream-health socket when the process exits without an explicit stop', async () => {

    const proc = new FfmpegStreamingProcess(createDelegate(), 'session-2', createOptions(), [ '-i', 'test' ], { addressVersion: 'ipv4', port: 0 });
    const child = lastChild();
    const internals = proc as unknown as { socket?: EventEmitter, streamTimeout?: NodeJS.Timeout };
    const socket = internals.socket;

    expect(socket).toBeDefined();
    await once(socket as EventEmitter, 'listening');

    const socketClosed = once(socket as EventEmitter, 'close');

    child.kill();
    child.emit('exit', null, null);

    await socketClosed;
    expect(internals.socket).toBeUndefined();
    expect(internals.streamTimeout).toBeUndefined();
  });
});
