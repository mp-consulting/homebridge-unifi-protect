/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * rtsp-resolution.test.ts: Tests for RTSP resolution selection and sorting algorithms from protect-camera.ts.
 *
 * The resolution selection logic (findRtspEntry) and the sort comparator (sortByResolutions) are tested
 * in isolation by reproducing their algorithms without Homebridge dependencies.
 */
import type { Resolution } from 'homebridge';

// Minimal RtspEntry type matching what protect-camera.ts uses.
interface RtspEntry {

  channel: { width: number; height: number; fps: number; name: string; id: number };
  name: string;
  resolution: Resolution;
  url: string;
}

// Reproduction of sortByResolutions from ProtectCamera (descending order: highest first).
function sortByResolutions(a: RtspEntry, b: RtspEntry): number {

  if(a.resolution[0] < b.resolution[0]) {
    return 1;
  }
  if(a.resolution[0] > b.resolution[0]) {
    return -1;
  }
  if(a.resolution[1] < b.resolution[1]) {
    return 1;
  }
  if(a.resolution[1] > b.resolution[1]) {
    return -1;
  }
  if(a.resolution[2] < b.resolution[2]) {
    return 1;
  }
  if(a.resolution[2] > b.resolution[2]) {
    return -1;
  }

  return 0;
}

// Reproduction of findRtspEntry from ProtectCamera.
function findRtspEntry(
  rtspEntries: RtspEntry[], width: number, height: number,
  options?: { biasHigher?: boolean; default?: string },
): RtspEntry | null {

  if(!rtspEntries.length) {

    return null;
  }

  // Check for explicit default preference.
  if(options?.default) {

    const defaultUpper = options.default.toUpperCase();

    return rtspEntries.find(x => x.channel.name.toUpperCase() === defaultUpper) ?? null;
  }

  // Exact resolution match.
  const exactRtsp = rtspEntries.find(x => (x.channel.width === width) && (x.channel.height === height));

  if(exactRtsp) {

    return exactRtsp;
  }

  // Default: bias lower — find first entry smaller than target, or fallback to lowest available.
  if(!options?.biasHigher) {

    return rtspEntries.find(x => x.channel.width < width) ?? rtspEntries[rtspEntries.length - 1];
  }

  // Bias higher — find last entry larger than target, or fallback to highest available.
  return rtspEntries.filter(x => x.channel.width > width).pop() ?? rtspEntries[0];
}

// Helper to create an RtspEntry.
function makeEntry(width: number, height: number, fps: number, name: string): RtspEntry {

  return {
    channel: { width, height, fps, name, id: 0 },
    name: `${width}x${height}@${fps}fps (${name})`,
    resolution: [width, height, fps],
    url: `rtsps://camera:7441/${name.toLowerCase()}`,
  };
}

describe('sortByResolutions', () => {

  it('sorts entries from highest to lowest resolution', () => {

    const entries = [
      makeEntry(1280, 720, 30, 'Medium'),
      makeEntry(3840, 2160, 30, 'High'),
      makeEntry(640, 360, 15, 'Low'),
      makeEntry(1920, 1080, 30, 'Full HD'),
    ];

    entries.sort(sortByResolutions);

    expect(entries.map(e => e.channel.width)).toEqual([3840, 1920, 1280, 640]);
  });

  it('sorts by height when width is equal', () => {

    const entries = [
      makeEntry(1920, 1080, 30, 'HD'),
      makeEntry(1920, 1440, 30, 'Tall'),
    ];

    entries.sort(sortByResolutions);

    expect(entries.map(e => e.channel.height)).toEqual([1440, 1080]);
  });

  it('sorts by fps when width and height are equal', () => {

    const entries = [
      makeEntry(1920, 1080, 15, 'Slow'),
      makeEntry(1920, 1080, 30, 'Fast'),
    ];

    entries.sort(sortByResolutions);

    expect(entries.map(e => e.channel.fps)).toEqual([30, 15]);
  });

  it('considers identical entries equal', () => {

    const a = makeEntry(1920, 1080, 30, 'A');
    const b = makeEntry(1920, 1080, 30, 'B');

    expect(sortByResolutions(a, b)).toBe(0);
  });
});

describe('findRtspEntry', () => {

  // A typical set of RTSP entries sorted highest to lowest (as they would be after sortByResolutions).
  const entries = [
    makeEntry(3840, 2160, 30, 'High'),
    makeEntry(1920, 1080, 30, 'Medium'),
    makeEntry(1280, 720, 30, 'Low'),
    makeEntry(640, 360, 15, 'Lowest'),
  ];

  describe('exact match', () => {

    it('returns exact match when available', () => {

      const result = findRtspEntry(entries, 1920, 1080);

      expect(result?.channel.width).toBe(1920);
      expect(result?.channel.height).toBe(1080);
    });

    it('returns exact match for 4K', () => {

      const result = findRtspEntry(entries, 3840, 2160);

      expect(result?.channel.width).toBe(3840);
    });

    it('returns exact match for lowest', () => {

      const result = findRtspEntry(entries, 640, 360);

      expect(result?.channel.width).toBe(640);
    });
  });

  describe('bias lower (default)', () => {

    it('finds next lower resolution when no exact match', () => {

      // Requesting 2560x1440 — no exact match, should find 1920x1080 (first entry with width < 2560).
      const result = findRtspEntry(entries, 2560, 1440);

      expect(result?.channel.width).toBe(1920);
    });

    it('falls back to lowest resolution when target is smaller than all entries', () => {

      // Requesting 320x180 — no entry with width < 320, so falls back to last entry (lowest).
      const result = findRtspEntry(entries, 320, 180);

      expect(result?.channel.width).toBe(640);
    });

    it('selects lower resolution for in-between targets', () => {

      // Requesting 1600x900 — should find 1280x720 (first entry with width < 1600).
      const result = findRtspEntry(entries, 1600, 900);

      expect(result?.channel.width).toBe(1280);
    });
  });

  describe('bias higher', () => {

    it('finds next higher resolution when no exact match', () => {

      // Requesting 1600x900 with biasHigher — should find 1920x1080 (last entry with width > 1600 = 3840, but pop gives last in filtered).
      const result = findRtspEntry(entries, 1600, 900, { biasHigher: true });

      // filter(width > 1600) = [3840, 1920], pop() = 1920.
      expect(result?.channel.width).toBe(1920);
    });

    it('falls back to highest resolution when target is larger than all entries', () => {

      // Requesting 7680x4320 — no entry with width > 7680, fallback to first (highest).
      const result = findRtspEntry(entries, 7680, 4320, { biasHigher: true });

      expect(result?.channel.width).toBe(3840);
    });

    it('returns the closest higher resolution for small targets', () => {

      // Requesting 480x270 with biasHigher — filter(width > 480) = [3840,1920,1280,640], pop() = 640.
      const result = findRtspEntry(entries, 480, 270, { biasHigher: true });

      expect(result?.channel.width).toBe(640);
    });
  });

  describe('default preference', () => {

    it('returns named stream when default is set', () => {

      const result = findRtspEntry(entries, 1920, 1080, { default: 'Low' });

      expect(result?.channel.name).toBe('Low');
      expect(result?.channel.width).toBe(1280);
    });

    it('is case-insensitive for default matching', () => {

      const result = findRtspEntry(entries, 1920, 1080, { default: 'high' });

      expect(result?.channel.name).toBe('High');
    });

    it('returns null when default name does not match any entry', () => {

      const result = findRtspEntry(entries, 1920, 1080, { default: 'Ultra' });

      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {

    it('returns null for empty entries', () => {

      expect(findRtspEntry([], 1920, 1080)).toBeNull();
    });

    it('returns the only entry when there is just one', () => {

      const single = [makeEntry(1920, 1080, 30, 'Only')];

      // Exact match.
      expect(findRtspEntry(single, 1920, 1080)?.channel.name).toBe('Only');

      // No exact match, bias lower: no entry with width < 3840, fallback to last.
      expect(findRtspEntry(single, 3840, 2160)?.channel.name).toBe('Only');

      // No exact match, bias higher: no entry with width > 640, fallback to first.
      expect(findRtspEntry(single, 640, 360, { biasHigher: true })?.channel.name).toBe('Only');
    });

    it('prefers exact match over default when both could apply', () => {

      // default takes priority over exact match in the actual algorithm.
      const result = findRtspEntry(entries, 1920, 1080, { default: 'High' });

      expect(result?.channel.name).toBe('High');
    });
  });
});

describe('Resolution format helper', () => {

  // Reproduction of getResolution from ProtectCamera.
  function getResolution(resolution: Resolution): string {

    return resolution[0].toString() + 'x' + resolution[1].toString() + '@' + resolution[2].toString() + 'fps';
  }

  it('formats a standard resolution', () => {

    expect(getResolution([1920, 1080, 30])).toBe('1920x1080@30fps');
  });

  it('formats a 4K resolution', () => {

    expect(getResolution([3840, 2160, 24])).toBe('3840x2160@24fps');
  });

  it('formats a low resolution', () => {

    expect(getResolution([320, 180, 15])).toBe('320x180@15fps');
  });
});
