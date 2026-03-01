/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * snapshot-cache.test.ts: Tests for snapshot cache expiry logic from protect-snapshot.ts.
 *
 * The cachedSnapshot getter determines whether a previously captured snapshot is still usable
 * based on its age relative to PROTECT_SNAPSHOT_CACHE_MAXAGE.
 */
import { PROTECT_SNAPSHOT_CACHE_MAXAGE } from '../src/settings.js';

// Reproduction of the cachedSnapshot getter logic from ProtectSnapshot.
function getCachedSnapshot(
  cache: { image: Buffer; time: number } | null,
  now: number,
  maxAge: number,
): Buffer | null {

  if(!cache || ((now - cache.time) > (maxAge * 1000))) {

    return null;
  }

  return cache.image;
}

describe('Snapshot Cache Expiry', () => {

  const IMAGE = Buffer.from('fake-jpeg-data');
  const MAX_AGE = PROTECT_SNAPSHOT_CACHE_MAXAGE;

  it('returns the cached image when it is fresh', () => {

    const now = Date.now();
    const cache = { image: IMAGE, time: now - 1000 }; // 1 second old.

    expect(getCachedSnapshot(cache, now, MAX_AGE)).toBe(IMAGE);
  });

  it('returns null when cache is null', () => {

    expect(getCachedSnapshot(null, Date.now(), MAX_AGE)).toBeNull();
  });

  it('returns null when cache is expired', () => {

    const now = Date.now();
    const cache = { image: IMAGE, time: now - (MAX_AGE * 1000) - 1 }; // Just past expiry.

    expect(getCachedSnapshot(cache, now, MAX_AGE)).toBeNull();
  });

  it('returns image when cache is exactly at the boundary', () => {

    const now = Date.now();
    const cache = { image: IMAGE, time: now - (MAX_AGE * 1000) }; // Exactly at maxAge.

    // (now - time) === maxAge * 1000, which is NOT > maxAge * 1000, so it should still be valid.
    expect(getCachedSnapshot(cache, now, MAX_AGE)).toBe(IMAGE);
  });

  it('returns image for brand new cache', () => {

    const now = Date.now();
    const cache = { image: IMAGE, time: now }; // Just cached.

    expect(getCachedSnapshot(cache, now, MAX_AGE)).toBe(IMAGE);
  });

  it('handles different max age values', () => {

    const now = Date.now();

    // With 1 second max age.
    const youngCache = { image: IMAGE, time: now - 500 };

    expect(getCachedSnapshot(youngCache, now, 1)).toBe(IMAGE);

    // Same cache but with 0 second max age (effectively disabled).
    const oldCache = { image: IMAGE, time: now - 500 };

    expect(getCachedSnapshot(oldCache, now, 0)).toBeNull();
  });

  it('PROTECT_SNAPSHOT_CACHE_MAXAGE is a positive number', () => {

    expect(typeof PROTECT_SNAPSHOT_CACHE_MAXAGE).toBe('number');
    expect(PROTECT_SNAPSHOT_CACHE_MAXAGE).toBeGreaterThan(0);
  });
});
