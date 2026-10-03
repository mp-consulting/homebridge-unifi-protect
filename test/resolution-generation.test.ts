/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * resolution-generation.test.ts: Tests for resolution set generation and HKSV frame rate adjustment in ProtectCameraVideo.configure().
 *
 * The video delegate generates a set of HomeKit-compatible resolutions based on the camera's native aspect ratio (4:3 or 16:9), maps each to the closest
 * RTSP channel available on the camera, and adjusts frame rates to meet HomeKit Secure Video requirements.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProtectCamera, RtspEntry } from '../src/devices/protect-camera.js';
import { ProtectCameraVideo } from '../src/devices/protect-camera-video.js';

// A camera channel as reported by the Protect controller.
type Channel = [ name: string, width: number, height: number, fps: number ];

// Run the real ProtectCameraVideo.configure() against a fake camera with the given channels, and return the resolutions we'd advertise to HomeKit.
async function generateResolutions(channels: Channel[]): Promise<[number, number, number][]> {

  const camera = {

    hints: {},
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    nvr: { config: {}, ufp: { host: '192.168.1.1', ports: { rtsps: 7441 } }, ufpApi: { enableRtsp: async (ufp: unknown): Promise<unknown> => ufp } },

    // Our streaming delegate is already configured, so configure() returns once it has published the resolutions it computed.
    stream: {},
    ufp: {

      channels: channels.map(([ name, width, height, fps ], id) => ({ bitrate: 2000000, fps, height, id, isRtspEnabled: true, name, rtspAlias: 'alias' + id.toString(),
        width })),
      connectionHost: '192.168.1.10',
      isThirdPartyCamera: false,
      videoCodec: 'h264',
    },
  } as unknown as ProtectCamera;

  const video = new ProtectCameraVideo(camera);

  await expect(video.configure()).resolves.toBe(true);

  return (video as unknown as { rtspEntries: RtspEntry[] }).rtspEntries.map(entry => entry.resolution);
}

// Strip frame rates from a resolution list.
const dimensions = (resolutions: [number, number, number][]): string[] => [ ...new Set(resolutions.map(([ width, height ]) => width.toString() + 'x' +
  height.toString())) ];

describe('Aspect ratio detection', () => {

  it('generates 4:3 resolutions for 4:3 cameras', async () => {

    const resolutions = await generateResolutions([ [ 'High', 1600, 1200, 30 ], [ 'Low', 640, 480, 15 ] ]);

    expect(dimensions(resolutions)).toEqual([ '1920x1440', '1600x1200', '1280x960', '640x480', '480x360', '320x240' ]);

    for(const [ width, height ] of resolutions) {

      expect(width / height).toBeCloseTo(4 / 3, 5);
    }
  });

  it('generates 16:9 resolutions for 16:9 cameras', async () => {

    const resolutions = await generateResolutions([ [ 'High', 3840, 2160, 30 ], [ 'Medium', 1280, 720, 30 ], [ 'Low', 640, 360, 15 ] ]);

    expect(dimensions(resolutions)).toEqual([ '3840x2160', '2560x1440', '1920x1080', '1280x720', '640x360', '480x270', '320x180' ]);

    for(const [ width, height ] of resolutions) {

      expect(width / height).toBeCloseTo(16 / 9, 5);
    }
  });

  it('falls through to 16:9 resolutions for non-standard aspect ratios', async () => {

    const resolutions = await generateResolutions([ [ 'High', 2000, 2000, 30 ] ]);

    expect(dimensions(resolutions)).toEqual([ '2000x2000', '1920x1080', '1280x720', '640x360', '480x270', '320x180' ]);
  });
});

describe('Resolution filtering', () => {

  it('excludes generated resolutions at or above the native resolution, except for the 1080p and 720p tiers HomeKit requires', async () => {

    const resolutions = dimensions(await generateResolutions([ [ 'High', 1280, 720, 30 ] ]));

    expect(resolutions).toContain('1920x1080');
    expect(resolutions).toContain('1280x720');
    expect(resolutions).not.toContain('2560x1440');
    expect(resolutions).not.toContain('3840x2160');
  });

  it('maps each generated resolution to the frame rate of the closest camera channel at or below it', async () => {

    const resolutions = await generateResolutions([ [ 'High', 1920, 1080, 30 ], [ 'Low', 640, 360, 15 ] ]);

    expect(resolutions).toEqual([

      [ 1920, 1080, 30 ],
      [ 1280, 720, 15 ],
      [ 640, 360, 15 ],
      [ 480, 270, 15 ],
      [ 320, 180, 15 ],
    ]);
  });

  it('ignores channels with nonsensical resolutions', async () => {

    const resolutions = await generateResolutions([ [ 'High', 1920, 1080, 30 ], [ 'Broken', 0, 1080, 30 ], [ 'Huge', 70000, 1080, 30 ] ]);

    expect(resolutions.every(([ width ]) => (width > 0) && (width <= 65535))).toBe(true);
  });
});

describe('HKSV frame rate adjustment', () => {

  it.each([

    [ 25, 30 ],
    [ 29, 30 ],
    [ 16, 24 ],
    [ 20, 24 ],
    [ 10, 15 ],
    [ 1, 15 ],
  ])('adjusts the first 1080p entry from %s fps to %s fps', async (fps, expected) => {

    const resolutions = await generateResolutions([ [ 'High', 1920, 1080, fps ] ]);

    expect(resolutions[0]).toEqual([ 1920, 1080, expected ]);

    // Only the first 1080p entry is adjusted.
    expect(resolutions.slice(1).every(([ , , entryFps ]) => entryFps === fps)).toBe(true);
  });

  it.each([ 15, 24, 30 ])('leaves a native %s fps stream untouched', async (fps) => {

    const resolutions = await generateResolutions([ [ 'High', 1920, 1080, fps ] ]);

    expect(resolutions.every(([ , , entryFps ]) => entryFps === fps)).toBe(true);
  });

  it('adjusts a 1440p-tall 1920-wide entry on 4:3 cameras', async () => {

    const resolutions = await generateResolutions([ [ 'High', 2688, 2016, 20 ] ]);

    expect(resolutions.find(([ width ]) => width === 1920)).toEqual([ 1920, 1440, 24 ]);
  });
});
