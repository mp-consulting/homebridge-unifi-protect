/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * playlist-filter.test.ts: Tests for M3U playlist camera filtering and sorting in protect-playlist.ts.
 *
 * The playlist only publishes cameras that can be streamed over RTSP (no AV1 codec, at least one RTSP-enabled channel), sorted alphabetically by name. These
 * tests exercise the real generatePlaylist() and inspect which cameras end up in the output, and in what order.
 */
import { describe, expect, it } from 'vitest';
import type { ProtectNvrBootstrapData } from '../src/unifi/index.js';
import { generatePlaylist } from '../src/protect-playlist.js';

interface CameraSpec {

  codec?: string;
  hasPackage?: boolean;
  name: string;
  rtspEnabled?: boolean;
}

// Build a minimal bootstrap containing the given cameras.
function makeBootstrap(cameras: CameraSpec[]): ProtectNvrBootstrapData {

  return {

    cameras: cameras.map(camera => {

      const alias = camera.name.toLowerCase().replace(/\s/g, '');

      return {

        channels: [
          { isRtspEnabled: camera.rtspEnabled ?? true, name: 'High', rtspAlias: alias + '_high' },
          { isRtspEnabled: camera.rtspEnabled ?? true, name: 'Medium', rtspAlias: alias + '_med' },
          ...(camera.hasPackage ? [{ isRtspEnabled: true, name: 'Package Camera', rtspAlias: alias + '_pkg' }] : []),
        ],
        featureFlags: { hasPackageCamera: camera.hasPackage ?? false },
        marketName: 'G4 Pro',
        name: camera.name,
        videoCodec: camera.codec ?? 'h264',
      };
    }),
    nvr: { host: '10.0.0.1', ports: { rtsp: 7447 } },
  } as unknown as ProtectNvrBootstrapData;
}

// Return the camera names published in a playlist, in order.
function publishedNames(cameras: CameraSpec[]): string[] {

  return [...generatePlaylist(makeBootstrap(cameras)).matchAll(/channel-id="([^"]*)"/g)].map(match => match[1] ?? '');
}

describe('M3U playlist camera filtering', () => {

  describe('codec filtering', () => {

    it('includes h264 cameras', () => {

      expect(publishedNames([{ codec: 'h264', name: 'Front Door' }])).toEqual(['Front Door']);
    });

    it('includes h265 cameras', () => {

      expect(publishedNames([{ codec: 'h265', name: 'Backyard' }])).toEqual(['Backyard']);
    });

    it('excludes av1 cameras', () => {

      expect(publishedNames([{ codec: 'av1', name: 'Garage' }])).toEqual([]);
    });

    it('filters out only av1 from a mixed set', () => {

      expect(publishedNames([{ codec: 'h264', name: 'A' }, { codec: 'av1', name: 'B' }, { codec: 'h265', name: 'C' }])).toEqual(['A', 'C']);
    });
  });

  describe('RTSP filtering', () => {

    it('excludes cameras with no RTSP-enabled channels', () => {

      expect(publishedNames([{ name: 'Disabled', rtspEnabled: false }])).toEqual([]);
    });

    it('excludes cameras that are both av1 and lack RTSP', () => {

      expect(publishedNames([{ codec: 'av1', name: 'Both', rtspEnabled: false }])).toEqual([]);
    });

    it('publishes the first RTSP alias as the stream URL', () => {

      expect(generatePlaylist(makeBootstrap([{ name: 'Front Door' }]))).toContain('rtsp://10.0.0.1:7447/frontdoor_high');
    });
  });

  describe('sorting', () => {

    it('sorts cameras alphabetically by name', () => {

      expect(publishedNames([{ name: 'Zebra' }, { name: 'Apple' }, { name: 'Mango' }])).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('keeps cameras with identical names', () => {

      expect(publishedNames([{ name: 'Same' }, { name: 'Same' }])).toEqual(['Same', 'Same']);
    });

    it('filters then sorts a mixed set of cameras', () => {

      expect(publishedNames([

        { name: 'Zulu' },
        { codec: 'av1', name: 'Alpha' },
        { name: 'Bravo', rtspEnabled: false },
        { name: 'Charlie' },
      ])).toEqual(['Charlie', 'Zulu']);
    });
  });

  describe('edge cases', () => {

    it('publishes only the header when every camera is excluded', () => {

      expect(generatePlaylist(makeBootstrap([{ codec: 'av1', name: 'X' }, { name: 'Y', rtspEnabled: false }]))).toBe('#EXTM3U\n');
    });

    it('publishes only the header for an empty camera list', () => {

      expect(generatePlaylist(makeBootstrap([]))).toBe('#EXTM3U\n');
    });

    it('adds a package camera entry right after its doorbell', () => {

      const names = publishedNames([{ hasPackage: true, name: 'Doorbell' }, { name: 'Yard' }]);

      expect(names).toHaveLength(3);
      expect(names[0]).toBe('Doorbell');
      expect(names[2]).toBe('Yard');
    });

    it('does not add a package entry for cameras without one', () => {

      expect(publishedNames([{ name: 'Doorbell' }])).toEqual(['Doorbell']);
    });
  });
});
