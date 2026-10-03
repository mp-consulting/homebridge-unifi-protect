/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-probesize.test.ts: Tests for adaptive FFmpeg probesize tuning and livestream API error classification.
 */
import { PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD, PROTECT_FFMPEG_PROBESIZE_MAX, PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT } from '../src/settings.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomebridgePluginLogging } from '../src/lib/index.js';
import { ProbesizeTuner } from '../src/protect-probesize.js';

function createLog(): HomebridgePluginLogging & { error: ReturnType<typeof vi.fn> } {

  // The double cast is required: vi.fn() mocks aren't structurally assignable to the logging signatures.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as HomebridgePluginLogging & { error: ReturnType<typeof vi.fn> };
}

describe('ProbesizeTuner', () => {

  beforeEach(() => {

    vi.useFakeTimers();
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it('uses the camera default until an adjustment is needed, and tracks changes to the default', () => {

    let base = 16384;
    const tuner = new ProbesizeTuner(createLog(), () => base);

    expect(tuner.probesize).toBe(16384);

    base = 32768;

    expect(tuner.probesize).toBe(32768);
  });

  it('doubles the probesize temporarily and reverts after the override timeout', () => {

    const log = createLog();
    const tuner = new ProbesizeTuner(log, () => 16384);

    tuner.adjust();

    expect(tuner.probesize).toBe(32768);
    expect(log.error.mock.calls[0]?.[1]).toBe('temporarily');

    // Adjustments compound while the override is active.
    tuner.adjust();

    expect(tuner.probesize).toBe(65536);

    vi.advanceTimersByTime(PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT);

    expect(tuner.probesize).toBe(16384);
  });

  it('caps the probesize at the configured maximum', () => {

    const tuner = new ProbesizeTuner(createLog(), () => PROTECT_FFMPEG_PROBESIZE_MAX - 1);

    tuner.adjust();

    expect(tuner.probesize).toBe(PROTECT_FFMPEG_PROBESIZE_MAX);
  });

  it('makes the override permanent once adjustments happen often enough', () => {

    const log = createLog();
    const tuner = new ProbesizeTuner(log, () => 1024);

    for(let i = 0; i < PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD; i++) {

      tuner.adjust();
    }

    expect(log.error.mock.calls.at(-1)?.[1]).toBe('permanently');

    const adjusted = tuner.probesize;

    vi.advanceTimersByTime(PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT * 2);

    expect(tuner.probesize).toBe(adjusted);
    expect(adjusted).toBeGreaterThan(1024);
  });

  describe('errorCheck', () => {

    const tuner = new ProbesizeTuner(createLog(), () => 16384);

    it.each([

      'Cannot determine format of input stream 0:0 after EOF',
      '[out#0/rtp] Finishing stream without any data written to it.',
      '[mov,mp4] could not find corresponding trex (id 1)',
      'moov atom not found',
    ])('recognizes known livestream API errors: %s', (entry) => {

      expect(tuner.errorCheck([ 'unrelated', entry ], true)).toMatch(/UniFi Protect livestream API/);
    });

    it('ignores known livestream API errors when not using API livestreaming', () => {

      expect(tuner.errorCheck([ 'moov atom not found' ], false)).toBeUndefined();
    });

    it('ignores unrecognized errors', () => {

      expect(tuner.errorCheck([ 'Connection refused' ], true)).toBeUndefined();
    });
  });
});
