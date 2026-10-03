/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * rtsp-resolution.test.ts: Tests for RTSP resolution selection and sorting in ProtectCameraVideo (protect-camera-video.ts).
 *
 * The real ProtectCameraVideo lookups (findRtsp, findRecordingRtsp) and the sortByResolutions comparator are exercised against a minimal fake camera.
 */
import type { ProtectCamera, RtspEntry } from '../src/devices/protect-camera.js';
import { ProtectCameraVideo, sortByResolutions } from '../src/devices/protect-camera-video.js';
import { formatResolution } from '../src/devices/protect-camera.js';

// Create a real video delegate backed by a fake camera carrying only the hints the RTSP lookups consult.
function makeVideo(hints: { recordingDefault?: string | undefined; streamingDefault?: string | undefined } = {}): ProtectCameraVideo {

  return new ProtectCameraVideo({ hints } as unknown as ProtectCamera);
}

// Look up an RTSP entry through the real ProtectCameraVideo.findRtsp(). An explicit default is supplied the same way production does: via the camera's
// streamingDefault hint.
function findRtspEntry(rtspEntries: RtspEntry[], width: number, height: number, options?: { biasHigher?: boolean; default?: string }): RtspEntry | null {

  return makeVideo({ streamingDefault: options?.default }).findRtsp(width, height, { biasHigher: options?.biasHigher, rtspEntries: [...rtspEntries] });
}

// Helper to create an RtspEntry.
function makeEntry(width: number, height: number, fps: number, name: string): RtspEntry {

  return {
    channel: { width, height, fps, name, id: 0 } as RtspEntry['channel'],
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

    it('requires a strictly narrower entry when the width matches but the height does not', () => {

      // Requesting 1920x1080 against a 4:3 1920x1440 channel - not an exact match, so we drop to the next narrower entry.
      const result = findRtspEntry([ makeEntry(1920, 1440, 30, 'High'), makeEntry(1280, 960, 30, 'Low') ], 1920, 1080);

      expect(result?.channel.name).toBe('Low');
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

describe('findRecordingRtsp', () => {

  const entries = [
    makeEntry(3840, 2160, 30, 'High'),
    makeEntry(1920, 1080, 30, 'Medium'),
    makeEntry(1280, 720, 30, 'Low'),
  ];

  // findRecordingRtsp() searches the delegate's own published entries, so seed them directly.
  function makeRecordingVideo(recordingDefault?: string): ProtectCameraVideo {

    const video = makeVideo({ recordingDefault });

    (video as unknown as { rtspEntries: RtspEntry[] }).rtspEntries = [...entries];

    return video;
  }

  it('biases toward the next higher resolution', () => {

    expect(makeRecordingVideo().findRecordingRtsp(1600, 900)?.channel.name).toBe('Medium');
  });

  it('honors the recording default hint regardless of the requested resolution', () => {

    expect(makeRecordingVideo('low').findRecordingRtsp(3840, 2160)?.channel.name).toBe('Low');
  });

  it('ignores the streaming default hint', () => {

    const video = new ProtectCameraVideo({ hints: { streamingDefault: 'Low' } } as unknown as ProtectCamera);

    (video as unknown as { rtspEntries: RtspEntry[] }).rtspEntries = [...entries];

    expect(video.findRecordingRtsp(3840, 2160)?.channel.name).toBe('High');
  });
});

describe('findRtsp maxPixels constraint', () => {

  const entries = [
    makeEntry(3840, 2160, 30, 'High'),
    makeEntry(1920, 1080, 30, 'Medium'),
    makeEntry(1280, 720, 30, 'Low'),
  ];

  it('filters out entries exceeding the pixel budget before selecting', () => {

    expect(makeVideo().findRtsp(3840, 2160, { maxPixels: 1920 * 1080, rtspEntries: [...entries] })?.channel.name).toBe('Medium');
  });

  it('returns null when no entry fits the pixel budget', () => {

    expect(makeVideo().findRtsp(1920, 1080, { maxPixels: 100, rtspEntries: [...entries] })).toBeNull();
  });
});

describe('formatResolution', () => {

  it('formats a standard resolution', () => {

    expect(formatResolution([1920, 1080, 30])).toBe('1920x1080@30fps');
  });

  it('formats a 4K resolution', () => {

    expect(formatResolution([3840, 2160, 24])).toBe('3840x2160@24fps');
  });

  it('formats a low resolution', () => {

    expect(formatResolution([320, 180, 15])).toBe('320x180@15fps');
  });
});
