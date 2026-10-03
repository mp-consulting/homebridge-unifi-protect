/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-playlist.test.ts: Tests for M3U playlist generation, name sanitization, and access control in protect-playlist.ts.
 */
import { ProtectPlaylistServer, generatePlaylist, isAuthorizedRequest, sanitizePlaylistName } from '../src/protect-playlist.js';
import { describe, expect, it, vi } from 'vitest';
import type { ProtectApi } from '../src/unifi/index.js';
import type { ProtectNvrBootstrapData } from '../src/unifi/index.js';

// Build a minimal bootstrap with the given cameras.
function makeBootstrap(cameras: { name: string, hasPackageCamera?: boolean }[]): ProtectNvrBootstrapData {

  return {

    cameras: cameras.map((camera, index) => ({

      channels: [
        { isRtspEnabled: true, name: 'High', rtspAlias: 'alias' + index.toString() },
        ...(camera.hasPackageCamera ? [{ isRtspEnabled: true, name: 'Package Camera', rtspAlias: 'pkg' + index.toString() }] : []),
      ],
      featureFlags: { hasPackageCamera: camera.hasPackageCamera ?? false },
      marketName: 'G4 Doorbell',
      name: camera.name,
      videoCodec: 'h264',
    })),
    nvr: { host: '10.0.0.1', ports: { rtsp: 7447 } },
  } as unknown as ProtectNvrBootstrapData;
}

describe('sanitizePlaylistName', () => {

  it('strips quotes and line breaks', () => {

    expect(sanitizePlaylistName('Front "Door"\r\n#EXTINF:0,evil')).toBe('Front Door#EXTINF:0,evil');
  });

  it('strips commas from display titles only', () => {

    expect(sanitizePlaylistName('Garage, Left')).toBe('Garage, Left');
    expect(sanitizePlaylistName('Garage, Left', true)).toBe('Garage Left');
  });
});

describe('generatePlaylist', () => {

  it('returns only the header without a bootstrap', () => {

    expect(generatePlaylist(null)).toBe('#EXTM3U\n');
  });

  it('cannot be used to inject playlist entries through camera names', () => {

    const playlist = generatePlaylist(makeBootstrap([{ name: 'Evil"\n#EXTINF:0,Injected\nrtsp://attacker/stream' }]));
    const lines = playlist.trim().split('\n');

    // Header, one #EXTINF line, and one URL line.
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('#EXTINF:0 channel-id="Evil#EXTINF:0,Injectedrtsp://attacker/stream"')).toBe(true);
    expect(lines[1]?.endsWith(', Evil#EXTINF:0Injectedrtsp://attacker/stream')).toBe(true);
    expect(lines[2]).toBe('rtsp://10.0.0.1:7447/alias0');
  });

  it('publishes package cameras', () => {

    const playlist = generatePlaylist(makeBootstrap([{ hasPackageCamera: true, name: 'Doorbell' }]));

    expect(playlist).toContain('rtsp://10.0.0.1:7447/pkg0');
    expect(playlist).toContain(', Doorbell Package Camera\n');
  });
});

describe('isAuthorizedRequest', () => {

  it('allows everything when no token is configured', () => {

    expect(isAuthorizedRequest('/', undefined)).toBe(true);
  });

  it('requires a matching token when one is configured', () => {

    expect(isAuthorizedRequest('/', 'secret')).toBe(false);
    expect(isAuthorizedRequest('/?token=wrong', 'secret')).toBe(false);
    expect(isAuthorizedRequest('/playlist.m3u?token=secret', 'secret')).toBe(true);
  });
});

describe('ProtectPlaylistServer', () => {

  it('serves the playlist only to clients presenting the token', async () => {

    const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const api = { bootstrap: makeBootstrap([{ name: 'Front' }]) } as unknown as ProtectApi;
    const server = new ProtectPlaylistServer(api, log, { address: '127.0.0.1', port: 0, token: 'secret' });

    await vi.waitFor(() => expect(server.listeningPort).toBeGreaterThan(0));

    const base = 'http://127.0.0.1:' + (server.listeningPort ?? 0).toString() + '/';

    try {

      expect((await fetch(base)).status).toBe(401);

      const response = await fetch(base + '?token=secret');

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('rtsp://10.0.0.1:7447/alias0');
      expect(log.warn).not.toHaveBeenCalled();
    } finally {

      server.close();
    }
  });

  it('warns when the playlist is published without a token', async () => {

    const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const server = new ProtectPlaylistServer({ bootstrap: null } as unknown as ProtectApi, log, { address: '127.0.0.1', port: 0 });

    try {

      await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('available to anyone'), ''));
    } finally {

      server.close();
    }
  });
});
