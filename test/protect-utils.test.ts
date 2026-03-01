/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-utils.test.ts: Unit tests for utility functions in protect-utils.ts.
 */
import type { Writable } from 'node:stream';
import { toCamelCase, createSegmentQueueProcessor } from '../src/protect-utils.js';

// Helper to create a mock Writable-like stdin object.
const createMockStdin = (canWrite = true) => {

  const written: Buffer[] = [];
  const listeners: Record<string, (() => void)[]> = {};

  return {
    write: vi.fn((data: Buffer) => {
      written.push(data);
      return canWrite;
    }),
    once: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    emit: (event: string) => listeners[event]?.forEach(cb => cb()),
    written,
  };
};

describe('toCamelCase', () => {

  it('converts a multi-word string to title case', () => {

    expect(toCamelCase('hello world')).toBe('Hello World');
  });

  it('capitalizes a single word', () => {

    expect(toCamelCase('hello')).toBe('Hello');
  });

  it('handles an empty string', () => {

    expect(toCamelCase('')).toBe('');
  });

  it('handles a single character', () => {

    expect(toCamelCase('a')).toBe('A');
  });

  it('handles multiple spaces between words', () => {

    // The regex matches \s+\w, so with multiple spaces the last space and the following char are matched.
    const result = toCamelCase('hello  world');
    expect(result).toBe('Hello  World');
  });

  it('handles already capitalized input', () => {

    expect(toCamelCase('Hello World')).toBe('Hello World');
  });
});

describe('createSegmentQueueProcessor', () => {

  it('writes a single segment to stdin', () => {

    const mockStdin = createMockStdin();
    const processor = createSegmentQueueProcessor(() => mockStdin as unknown as Writable);
    const segment = Buffer.from('test-segment');

    processor(segment);

    expect(mockStdin.write).toHaveBeenCalledWith(segment);
    expect(mockStdin.written).toEqual([segment]);
  });

  it('queues segments when write returns false (backpressure)', () => {

    const mockStdin = createMockStdin(false);
    const processor = createSegmentQueueProcessor(() => mockStdin as unknown as Writable);
    const segment1 = Buffer.from('segment-1');
    const segment2 = Buffer.from('segment-2');

    processor(segment1);
    processor(segment2);

    // Only the first segment should have been written; the second is queued because isWriting is true.
    expect(mockStdin.write).toHaveBeenCalledTimes(1);
    expect(mockStdin.written).toEqual([segment1]);
  });

  it('processes the queue after the drain event', () => {

    const mockStdin = createMockStdin(false);
    const processor = createSegmentQueueProcessor(() => mockStdin as unknown as Writable);
    const segment1 = Buffer.from('segment-1');
    const segment2 = Buffer.from('segment-2');

    processor(segment1);
    processor(segment2);

    expect(mockStdin.write).toHaveBeenCalledTimes(1);

    // Now allow writes to succeed and simulate the drain event.
    mockStdin.write.mockImplementation((data: Buffer) => {
      mockStdin.written.push(data);
      return true;
    });
    mockStdin.emit('drain');

    // segment2 should now have been written.
    expect(mockStdin.write).toHaveBeenCalledTimes(2);
    expect(mockStdin.written).toEqual([segment1, segment2]);
  });

  it('calls onSegmentWritten callback after a successful write', () => {

    const mockStdin = createMockStdin(true);
    const onSegmentWritten = vi.fn();
    const processor = createSegmentQueueProcessor(() => mockStdin as unknown as Writable, onSegmentWritten);
    const segment = Buffer.from('test-segment');

    processor(segment);

    expect(onSegmentWritten).toHaveBeenCalledTimes(1);
  });

  it('handles null stdin gracefully without crashing', () => {

    const processor = createSegmentQueueProcessor(() => null);
    const segment = Buffer.from('test-segment');

    // Should not throw.
    expect(() => processor(segment)).not.toThrow();
  });

  it('processes multiple segments in order', () => {

    const mockStdin = createMockStdin(true);
    const processor = createSegmentQueueProcessor(() => mockStdin as unknown as Writable);
    const segment1 = Buffer.from('first');
    const segment2 = Buffer.from('second');
    const segment3 = Buffer.from('third');

    processor(segment1);
    processor(segment2);
    processor(segment3);

    // All segments should be written in order since write returns true (no backpressure).
    expect(mockStdin.written).toEqual([segment1, segment2, segment3]);
  });
});
