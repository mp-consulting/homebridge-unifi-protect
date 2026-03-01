/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-utils.ts: Utility functions for UniFi Protect.
 */
import type { Writable } from 'node:stream';

// Convert a string to camel case.
export function toCamelCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

// Create a segment queue processor for managing backpressure when writing fMP4 segments to FFmpeg. Returns a function that enqueues and processes segments.
export function createSegmentQueueProcessor(stdinProvider: () => Writable | null | undefined, onSegmentWritten?: () => void): (segment?: Buffer) => void {

  const segmentQueue: Buffer[] = [];
  let isWriting = false;

  const processSegmentQueue = (segment?: Buffer): void => {

    // Add the segment to the queue.
    if(segment) {

      segmentQueue.push(segment);
    }

    // If we already have a write in progress, or nothing left to write, we're done.
    if(isWriting || !segmentQueue.length) {

      return;
    }

    // Dequeue and write.
    isWriting = true;
    segment = segmentQueue.shift();

    const stdin = stdinProvider();

    // Send the segment to FFmpeg for processing.
    if(!stdin?.write(segment)) {

      // FFmpeg isn't ready to read more data yet, queue the segment until we are.
      stdin?.once('drain', () => {

        // Mark us available to write and process the write queue.
        isWriting = false;
        processSegmentQueue();
      });
    } else {

      // Update our statistics and process the next segment.
      onSegmentWritten?.();
      isWriting = false;
      processSegmentQueue();
    }
  };

  return processSegmentQueue;
}
