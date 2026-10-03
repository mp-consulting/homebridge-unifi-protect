/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-utils.ts: Utility functions for UniFi Protect.
 */
import type { HomebridgePluginLogging } from './lib/index.js';
import { PROTECT_SEGMENT_QUEUE_MAXLENGTH } from './settings.js';
import type { Writable } from 'node:stream';

// Convert a string to camel case.
export function toCamelCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

// Deep merge utility for Protect JSON update payloads. Handles deep objects while accounting for Protect's specific merge quirks.
export function mergeJson(...objects: Record<string, unknown>[]): Record<string, unknown> {

  const result = {} as Record<string, unknown>;

  // Utility to validate if a value is an object, excluding arrays.
  const isObject = (value: unknown): value is Record<string, unknown> => (typeof value === 'object') && !Array.isArray(value) && (value !== null);

  // Process each object in the input array.
  for(const object of objects) {

    for(const key of Object.keys(object).filter(key => Object.hasOwn(object, key))) {

      const existingValue = result[key];
      const newValue = object[key];

      // Check if both values are non-array, non-null objects — if so, recurse.
      if(isObject(existingValue) && isObject(newValue)) {

        result[key] = mergeJson(existingValue, newValue);

        continue;
      }

      result[key] = newValue;
    }
  }

  return result;
}

// Format a duration in seconds into a human-readable string with appropriate time units.
export function formatRecordingDuration(recordedSeconds: number): { time: string; unit: string } {

  let recordedTime = '';

  const hours = Math.floor(recordedSeconds / 3600);
  const minutes = Math.floor((recordedSeconds % 3600) / 60);
  const seconds = Math.floor((recordedSeconds % 3600) % 60);

  if(recordedSeconds < 1) {

    recordedTime = recordedSeconds.toString();
  } else if(recordedSeconds < 60) {

    recordedTime = Math.round(recordedSeconds).toString();
  } else {

    if(hours > 9) {

      recordedTime = hours.toString() + ':';
    } else if(hours > 0) {

      recordedTime = '0' + hours.toString() + ':';
    }

    if(minutes > 9) {

      recordedTime += minutes.toString() + ':';
    } else if(minutes > 0) {

      recordedTime += ((hours > 0) ? '0' : '') + minutes.toString() + ':';
    } else if(hours > 0) {

      recordedTime += '00:';
    }

    if(recordedTime.length && (seconds < 10)) {

      recordedTime += '0' + seconds.toString();
    } else {

      recordedTime += seconds ? seconds.toString() : recordedSeconds.toString();
    }
  }

  let unit;

  switch(recordedTime.split(':').length - 1) {

    case 1:

      unit = 'minute';

      break;

    case 2:

      unit = 'hour';

      break;

    default:

      unit = 'second';

      break;
  }

  return { time: recordedTime, unit };
}

// Create a segment queue processor for managing backpressure when writing fMP4 segments to FFmpeg. Returns a function that enqueues and processes segments.
// The queue is bounded: if FFmpeg stops consuming input, we discard the oldest queued segments beyond maxLength rather than growing without limit.
export function createSegmentQueueProcessor(stdinProvider: () => Writable | null | undefined, onSegmentWritten?: () => void,
  options: { log?: HomebridgePluginLogging, maxLength?: number } = {}): (segment?: Buffer) => void {

  const maxLength = Math.max(options.maxLength ?? PROTECT_SEGMENT_QUEUE_MAXLENGTH, 1);
  const segmentQueue: Buffer[] = [];
  let droppedSegments = 0;
  let isWriting = false;

  const processSegmentQueue = (segment?: Buffer): void => {

    // Add the segment to the queue.
    if(segment) {

      segmentQueue.push(segment);

      // FFmpeg isn't keeping up. Discard the oldest segment so a stalled process can't consume memory without bound. We only log periodically to avoid
      // flooding the log while a stall persists.
      if(segmentQueue.length > maxLength) {

        segmentQueue.shift();

        if(!(droppedSegments++ % 100)) {

          options.log?.debug('FFmpeg is not keeping up with the livestream: discarded %s queued segment(s) beyond the %s segment queue limit.',
            droppedSegments, maxLength);
        }
      }
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
