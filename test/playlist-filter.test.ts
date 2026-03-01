/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * playlist-filter.test.ts: Tests for M3U playlist camera filtering and sorting logic from protect-playlist.ts.
 *
 * The playlist server filters cameras (no AV1 codec, at least one RTSP-enabled channel) and sorts
 * them alphabetically by name. These tests validate the filter and sort predicates in isolation.
 */

// Minimal camera type for the filter/sort logic.
interface PlaylistCamera {

  name: string;
  videoCodec: string;
  channels: { isRtspEnabled: boolean; name: string; rtspAlias: string }[];
  featureFlags: { hasPackageCamera: boolean };
}

// Reproduction of the camera filter predicate from ProtectPlaylistServer.
function filterPlaylistCameras(cameras: PlaylistCamera[]): PlaylistCamera[] {

  return cameras
    .filter(x => (x.videoCodec !== 'av1') && x.channels.some(channel => channel.isRtspEnabled))
    .sort((a, b) => {

      if(!a.name || !b.name) {
        return 0;
      }
      if(a.name < b.name) {
        return -1;
      }
      if(a.name > b.name) {
        return 1;
      }

      return 0;
    });
}

// Helper to create a mock camera.
function makeCamera(name: string, codec = 'h264', rtspEnabled = true, hasPackage = false): PlaylistCamera {

  return {
    name,
    videoCodec: codec,
    channels: [
      { isRtspEnabled: rtspEnabled, name: 'High', rtspAlias: name.toLowerCase().replace(/\s/g, '') + '_high' },
      { isRtspEnabled: rtspEnabled, name: 'Medium', rtspAlias: name.toLowerCase().replace(/\s/g, '') + '_med' },
    ],
    featureFlags: { hasPackageCamera: hasPackage },
  };
}

describe('M3U Playlist Camera Filtering', () => {

  describe('codec filtering', () => {

    it('includes h264 cameras', () => {

      const cameras = [makeCamera('Front Door', 'h264')];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(1);
    });

    it('includes h265/hevc cameras', () => {

      const cameras = [makeCamera('Back Yard', 'h265')];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(1);
    });

    it('excludes av1 cameras', () => {

      const cameras = [makeCamera('AV1 Camera', 'av1')];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(0);
    });

    it('filters out only av1 from mixed set', () => {

      const cameras = [
        makeCamera('H264 Cam', 'h264'),
        makeCamera('AV1 Cam', 'av1'),
        makeCamera('H265 Cam', 'h265'),
      ];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(2);
      expect(result.map(c => c.name)).toEqual(['H264 Cam', 'H265 Cam']);
    });
  });

  describe('RTSP filtering', () => {

    it('excludes cameras with no RTSP-enabled channels', () => {

      const cameras = [makeCamera('No RTSP', 'h264', false)];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(0);
    });

    it('includes cameras with at least one RTSP-enabled channel', () => {

      const camera: PlaylistCamera = {
        name: 'Partial RTSP',
        videoCodec: 'h264',
        channels: [
          { isRtspEnabled: false, name: 'High', rtspAlias: 'partial_high' },
          { isRtspEnabled: true, name: 'Medium', rtspAlias: 'partial_med' },
        ],
        featureFlags: { hasPackageCamera: false },
      };

      const result = filterPlaylistCameras([camera]);

      expect(result).toHaveLength(1);
    });

    it('excludes cameras with both av1 codec and no RTSP', () => {

      const cameras = [makeCamera('Excluded', 'av1', false)];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(0);
    });
  });

  describe('alphabetical sorting', () => {

    it('sorts cameras alphabetically by name', () => {

      const cameras = [
        makeCamera('Garage'),
        makeCamera('Back Door'),
        makeCamera('Front Door'),
        makeCamera('Attic'),
      ];
      const result = filterPlaylistCameras(cameras);

      expect(result.map(c => c.name)).toEqual(['Attic', 'Back Door', 'Front Door', 'Garage']);
    });

    it('handles cameras with identical names', () => {

      const cameras = [makeCamera('Camera'), makeCamera('Camera')];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(2);
    });

    it('handles single camera', () => {

      const cameras = [makeCamera('Solo')];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Solo');
    });
  });

  describe('combined filter and sort', () => {

    it('filters then sorts a mixed set of cameras', () => {

      const cameras = [
        makeCamera('Zebra Cam', 'h264'),
        makeCamera('AV1 Only', 'av1'),
        makeCamera('Alpha Cam', 'h265'),
        makeCamera('No Stream', 'h264', false),
        makeCamera('Middle Cam', 'h264'),
      ];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(3);
      expect(result.map(c => c.name)).toEqual(['Alpha Cam', 'Middle Cam', 'Zebra Cam']);
    });

    it('returns empty array for all-excluded cameras', () => {

      const cameras = [
        makeCamera('AV1', 'av1'),
        makeCamera('No RTSP', 'h264', false),
      ];
      const result = filterPlaylistCameras(cameras);

      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {

      expect(filterPlaylistCameras([])).toHaveLength(0);
    });
  });

  describe('package camera detection', () => {

    it('identifies cameras with package camera feature', () => {

      const camera = makeCamera('Doorbell Pro', 'h264', true, true);

      expect(camera.featureFlags.hasPackageCamera).toBe(true);
    });

    it('identifies cameras without package camera feature', () => {

      const camera = makeCamera('Regular Cam');

      expect(camera.featureFlags.hasPackageCamera).toBe(false);
    });
  });
});
