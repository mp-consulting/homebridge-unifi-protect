/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * timeshift-buffer.test.ts: Tests for timeshift buffer arithmetic from protect-timeshift.ts.
 *
 * These tests validate the buffer sizing, time calculations, and segment slicing logic
 * without requiring the full ProtectTimeshiftBuffer class or its Homebridge dependencies.
 */

// Reproduction of the timeshift buffer arithmetic from ProtectTimeshiftBuffer.
class TimeshiftBufferModel {

  private _buffer: Buffer[] = [];
  private _segmentLength: number;
  private segmentCount: number;
  private initSegment: Buffer | null = null;

  constructor(segmentLength: number, segmentCount = 1) {

    this._segmentLength = segmentLength;
    this.segmentCount = segmentCount;
  }

  setInitSegment(segment: Buffer): void {

    this.initSegment = segment;
  }

  push(segment: Buffer): void {

    this._buffer.push(segment);

    if(this._buffer.length > this.segmentCount) {

      this._buffer.shift();
    }
  }

  get time(): number {

    return this._buffer.length * this._segmentLength;
  }

  get configuredDuration(): number {

    return this.segmentCount * this._segmentLength;
  }

  set configuredDuration(bufferMillis: number) {

    this.segmentCount = Math.max(bufferMillis / this._segmentLength, 1);
  }

  get segmentLength(): number {

    return this._segmentLength;
  }

  get bufferLength(): number {

    return this._buffer.length;
  }

  get buffer(): Buffer | null {

    return (this.initSegment && this._buffer.length) ? Buffer.concat([this.initSegment, ...this._buffer]) : null;
  }

  getLast(duration: number): Buffer | null {

    if(!duration) {

      return null;
    }

    const start = duration / this._segmentLength;

    if(start >= this._buffer.length) {

      return this.buffer;
    }

    return (this.initSegment && this._buffer.length) ? Buffer.concat([this.initSegment, ...this._buffer.slice(start * -1)]) : null;
  }

  isInitSegment(segment: Buffer): boolean {

    return this.initSegment?.equals(segment) ?? false;
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
