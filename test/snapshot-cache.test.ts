/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * snapshot-cache.test.ts: Tests for the snapshot cache expiry in ProtectSnapshot (protect-snapshot.ts).
 *
 * The private cachedSnapshot getter determines whether a previously captured snapshot is still usable as a fallback, based on its age relative to
 * PROTECT_SNAPSHOT_CACHE_MAXAGE. The shorter freshness window is covered in snapshot-pipeline.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTECT_SNAPSHOT_CACHE_MAXAGE } from '../src/settings.js';
import type { ProtectCamera } from '../src/devices/index.js';
import { ProtectSnapshot } from '../src/protect-snapshot.js';

// The private state of ProtectSnapshot that we seed and inspect.
interface SnapshotInternals {

  _cachedSnapshot: { image: Buffer; lastMotion: null; lastRing: null; time: number } | null;
  readonly cachedSnapshot: Buffer | null;
}

const NOW = 1_700_000_000_000;
const IMAGE = Buffer.from('fake-jpeg-data');

// Create a real ProtectSnapshot with a cached image taken at the given time, and read it back through the cachedSnapshot getter.
function readCache(time: number | null): { internals: SnapshotInternals; result: Buffer | null } {

  const snapshot = new ProtectSnapshot({ log: {}, nvr: {}, platform: {} } as unknown as ProtectCamera) as unknown as SnapshotInternals;

  snapshot._cachedSnapshot = (time === null) ? null : { image: IMAGE, lastMotion: null, lastRing: null, time };

  return { internals: snapshot, result: snapshot.cachedSnapshot };
}

describe('Snapshot Cache Expiry', () => {

  const MAX_AGE_MS = PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000;

  beforeEach(() => {

    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it('returns the cached image when it is fresh', () => {

    expect(readCache(NOW - 1000).result).toBe(IMAGE);
  });

  it('returns null when nothing is cached', () => {

    expect(readCache(null).result).toBeNull();
  });

  it('returns null and discards the cache when it is expired', () => {

    const { internals, result } = readCache(NOW - MAX_AGE_MS - 1);

    expect(result).toBeNull();
    expect(internals._cachedSnapshot).toBeNull();
  });

  it('returns the image when the cache is exactly at the boundary', () => {

    // (now - time) === maxAge * 1000, which is NOT > maxAge * 1000, so it should still be valid.
    expect(readCache(NOW - MAX_AGE_MS).result).toBe(IMAGE);
  });

  it('returns the image for a brand new cache', () => {

    expect(readCache(NOW).result).toBe(IMAGE);
  });

  it('keeps an unexpired cache in place after reading it', () => {

    const { internals } = readCache(NOW - 1000);

    expect(internals._cachedSnapshot?.image).toBe(IMAGE);
  });

  it('PROTECT_SNAPSHOT_CACHE_MAXAGE is a positive number', () => {

    expect(typeof PROTECT_SNAPSHOT_CACHE_MAXAGE).toBe('number');
    expect(PROTECT_SNAPSHOT_CACHE_MAXAGE).toBeGreaterThan(0);
  });
});
