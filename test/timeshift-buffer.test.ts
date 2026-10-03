/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * timeshift-buffer.test.ts: Tests for the timeshift buffer in ProtectTimeshiftBuffer (protect-timeshift.ts).
 *
 * These tests validate the buffer sizing, time calculations, and segment slicing logic of the real ProtectTimeshiftBuffer, fed by a fake livestream.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ProtectCamera } from '../src/devices/index.js';
import { ProtectTimeshiftBuffer } from '../src/protect-timeshift.js';
import type { RtspEntry } from '../src/devices/protect-camera.js';

// A fake livestream: an event emitter that carries the fMP4 initialization segment.
class FakeLivestream extends EventEmitter {

  public initSegment: Buffer | null = null;

  public async getInitSegment(): Promise<Buffer> {

    return Promise.reject(new Error('stopped'));
  }
}

// Build a fake camera whose livestream manager hands out the given fake livestream.
function makeCamera(livestream: FakeLivestream): ProtectCamera {

  return {

    hasFeature: (): boolean => false,
    livestream: { acquire: (): FakeLivestream => livestream, isRestarting: (): boolean => false, start: async (): Promise<boolean> => true, stop: vi.fn() },
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as unknown as ProtectCamera;
}

// A harness around the real ProtectTimeshiftBuffer. Segments are delivered through the buffer's own livestream segment handler, exactly as a live
// livestream would deliver them.
class TimeshiftBufferModel {

  public readonly livestream = new FakeLivestream();
  public readonly real: ProtectTimeshiftBuffer;

  constructor(segmentLength: number, segmentCount = 1) {

    this.real = new ProtectTimeshiftBuffer(makeCamera(this.livestream));

    const internals = this.real as unknown as { _segmentLength: number; livestream: FakeLivestream };

    internals._segmentLength = segmentLength;
    internals.livestream = this.livestream;
    this.real.configuredDuration = segmentCount * segmentLength;
  }

  setInitSegment(segment: Buffer): void {

    this.livestream.initSegment = segment;
  }

  push(segment: Buffer): void {

    (this.real as unknown as { eventHandlers: { segment: (segment: Buffer) => void } }).eventHandlers.segment(segment);
  }

  get time(): number {

    return this.real.time;
  }

  get configuredDuration(): number {

    return this.real.configuredDuration;
  }

  set configuredDuration(bufferMillis: number) {

    this.real.configuredDuration = bufferMillis;
  }

  get bufferLength(): number {

    return (this.real as unknown as { _buffer: Buffer[] })._buffer.length;
  }

  get buffer(): Buffer | null {

    return this.real.buffer;
  }

  getLast(duration: number): Buffer | null {

    return this.real.getLast(duration);
  }

  isInitSegment(segment: Buffer): boolean {

    return this.real.isInitSegment(segment);
  }
}

describe('Timeshift Buffer Arithmetic', () => {

  const SEGMENT_LENGTH = 250; // 250ms per segment.

  describe('configuredDuration', () => {

    it('calculates configured duration from segment count and length', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 40);

      expect(buffer.configuredDuration).toBe(10000); // 40 * 250ms = 10000ms.
    });

    it('sets segment count from duration', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH);

      buffer.configuredDuration = 5000; // 5 seconds.

      // 5000 / 250 = 20 segments.
      expect(buffer.configuredDuration).toBe(5000);
    });

    it('enforces minimum of 1 segment when setting duration', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH);

      buffer.configuredDuration = 0; // Should result in Math.max(0/250, 1) = 1.

      expect(buffer.configuredDuration).toBe(SEGMENT_LENGTH); // 1 * 250ms.
    });

    it('enforces minimum of 1 segment for very small durations', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH);

      buffer.configuredDuration = 100; // Less than one segment.

      // Math.max(100/250, 1) = Math.max(0.4, 1) = 1.
      expect(buffer.configuredDuration).toBe(SEGMENT_LENGTH);
    });
  });

  describe('time (current buffer duration)', () => {

    it('starts at 0 with an empty buffer', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);

      expect(buffer.time).toBe(0);
    });

    it('increases as segments are added', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);

      buffer.push(Buffer.from('seg1'));
      expect(buffer.time).toBe(250);

      buffer.push(Buffer.from('seg2'));
      expect(buffer.time).toBe(500);

      buffer.push(Buffer.from('seg3'));
      expect(buffer.time).toBe(750);
    });

    it('caps at configured duration when buffer is full', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 4);

      // Fill it up.
      for(let i = 0; i < 4; i++) {

        buffer.push(Buffer.from(`seg${i}`));
      }

      expect(buffer.time).toBe(1000); // 4 * 250ms.

      // Add one more - should evict oldest.
      buffer.push(Buffer.from('seg4'));

      expect(buffer.time).toBe(1000); // Still 4 * 250ms.
      expect(buffer.bufferLength).toBe(4);
    });
  });

  describe('buffer trimming', () => {

    it('evicts oldest segment when capacity is exceeded', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 3);
      buffer.setInitSegment(Buffer.from('init'));

      buffer.push(Buffer.from('A'));
      buffer.push(Buffer.from('B'));
      buffer.push(Buffer.from('C'));

      expect(buffer.bufferLength).toBe(3);

      buffer.push(Buffer.from('D'));

      expect(buffer.bufferLength).toBe(3);

      // Buffer should now contain B, C, D (A was evicted).
      const full = buffer.buffer;

      expect(full).not.toBeNull();
      expect(full!.toString()).toBe('initBCD');
    });
  });

  describe('getLast', () => {

    it('returns null for duration of 0', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));
      buffer.push(Buffer.from('seg'));

      expect(buffer.getLast(0)).toBeNull();
    });

    it('returns full buffer when requested duration exceeds buffer content', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));
      buffer.push(Buffer.from('A'));
      buffer.push(Buffer.from('B'));

      // 2 segments = 500ms. Requesting 5000ms (> 500ms), so return everything.
      const result = buffer.getLast(5000);

      expect(result).not.toBeNull();
      expect(result!.toString()).toBe('initAB');
    });

    it('returns a subset when requested duration is less than buffer content', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('I'));

      // Fill with 8 segments (8 * 250 = 2000ms).
      for(let i = 0; i < 8; i++) {

        buffer.push(Buffer.from(i.toString()));
      }

      // Request last 500ms = 2 segments.
      const result = buffer.getLast(500);

      expect(result).not.toBeNull();
      // Init + last 2 segments (6,7).
      expect(result!.toString()).toBe('I67');
    });

    it('returns null when there is no init segment', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.push(Buffer.from('seg'));

      expect(buffer.getLast(1000)).toBeNull();
    });

    it('returns null when buffer is empty', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));

      // No segments added, buffer is empty.
      expect(buffer.getLast(1000)).toBeNull();
    });
  });

  describe('buffer property', () => {

    it('returns null when no init segment is set', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.push(Buffer.from('data'));

      expect(buffer.buffer).toBeNull();
    });

    it('returns null when buffer is empty', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));

      expect(buffer.buffer).toBeNull();
    });

    it('returns concatenated init + segments', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('INIT'));
      buffer.push(Buffer.from('A'));
      buffer.push(Buffer.from('B'));

      expect(buffer.buffer!.toString()).toBe('INITAB');
    });
  });

  describe('isInitSegment', () => {

    it('returns true for the init segment', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      const init = Buffer.from('init-segment-data');
      buffer.setInitSegment(init);

      expect(buffer.isInitSegment(init)).toBe(true);
    });

    it('returns true for a Buffer with identical content', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));

      // Different Buffer instance, same content.
      expect(buffer.isInitSegment(Buffer.from('init'))).toBe(true);
    });

    it('returns false for a different buffer', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);
      buffer.setInitSegment(Buffer.from('init'));

      expect(buffer.isInitSegment(Buffer.from('other'))).toBe(false);
    });

    it('returns false when no init segment is set', () => {

      const buffer = new TimeshiftBufferModel(SEGMENT_LENGTH, 10);

      expect(buffer.isInitSegment(Buffer.from('anything'))).toBe(false);
    });
  });

  describe('different segment lengths', () => {

    it('works with 100ms segment length', () => {

      const buffer = new TimeshiftBufferModel(100, 50);

      expect(buffer.configuredDuration).toBe(5000); // 50 * 100ms.

      buffer.configuredDuration = 2000;
      expect(buffer.configuredDuration).toBe(2000); // 20 * 100ms.
    });

    it('works with 1000ms segment length', () => {

      const buffer = new TimeshiftBufferModel(1000, 10);

      expect(buffer.configuredDuration).toBe(10000);
      expect(buffer.time).toBe(0);

      buffer.push(Buffer.from('seg'));

      expect(buffer.time).toBe(1000);
    });
  });
});

describe('Timeshift Buffer livestream lifecycle', () => {

  const rtspEntry = { channel: { id: 0 } } as RtspEntry;

  it('starts with the default segment resolution and fills from livestream segments', async () => {

    const livestream = new FakeLivestream();
    const buffer = new ProtectTimeshiftBuffer(makeCamera(livestream));

    livestream.initSegment = Buffer.from('I');

    await expect(buffer.start(rtspEntry)).resolves.toBe(true);
    expect(buffer.isStarted).toBe(true);

    buffer.configuredDuration = buffer.segmentLength * 2;
    livestream.emit('segment', Buffer.from('A'));
    livestream.emit('segment', Buffer.from('B'));
    livestream.emit('segment', Buffer.from('C'));

    expect(buffer.buffer?.toString()).toBe('IBC');
  });

  it('fails to start, and stops, when no initialization segment arrives', async () => {

    const livestream = new FakeLivestream();
    const buffer = new ProtectTimeshiftBuffer(makeCamera(livestream));

    await expect(buffer.start(rtspEntry)).resolves.toBe(false);
    expect(buffer.isStarted).toBe(false);
  });

  it('transmits the queued buffer first, then forwards live segments while transmitting', async () => {

    const livestream = new FakeLivestream();
    const buffer = new ProtectTimeshiftBuffer(makeCamera(livestream));
    const emitted: string[] = [];

    livestream.initSegment = Buffer.from('I');
    await buffer.start(rtspEntry);
    buffer.configuredDuration = buffer.segmentLength * 10;
    buffer.on('segment', (segment: Buffer) => emitted.push(segment.toString()));

    livestream.emit('segment', Buffer.from('A'));
    await expect(buffer.transmitStart()).resolves.toBe(true);
    livestream.emit('segment', Buffer.from('B'));
    buffer.transmitStop();
    livestream.emit('segment', Buffer.from('C'));

    expect(emitted).toEqual([ 'IA', 'B' ]);
  });

  it('clears the buffer when stopped', async () => {

    const livestream = new FakeLivestream();
    const buffer = new ProtectTimeshiftBuffer(makeCamera(livestream));

    livestream.initSegment = Buffer.from('I');
    await buffer.start(rtspEntry);
    livestream.emit('segment', Buffer.from('A'));
    buffer.stop();

    expect(buffer.time).toBe(0);
    expect(buffer.buffer).toBeNull();
    expect(livestream.listenerCount('segment')).toBe(0);
  });
});
