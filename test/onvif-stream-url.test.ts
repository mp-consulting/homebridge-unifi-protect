/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * onvif-stream-url.test.ts: Tests for the ONVIF / third-party RTSP override and host fallback logic
 * in protect-camera-video.ts. The URL construction and rtspEntries derivation are exercised in
 * isolation against the same algorithm the production code runs.
 */

interface Channel {

  fps: number;
  height: number;
  isRtspEnabled: boolean;
  name: string;
  rtspAlias: string;
  width: number;
}

interface UfpSummary {

  channels: Channel[];
  connectionHost?: string | null;
  isThirdPartyCamera: boolean;
  videoCodec: string;
}

interface NvrSummary {

  configOverrideAddress?: string;
  host: string;
  rtspsPort: number;
}

// Mirrors the per-channel URL construction in ProtectCameraVideo.configure() for the non-override branch.
function buildRelayUrl(ufp: UfpSummary, nvr: NvrSummary, alias: string): string {

  const host = nvr.configOverrideAddress ?? (ufp.isThirdPartyCamera ? nvr.host : ufp.connectionHost) ?? nvr.host;

  return 'rtsps://' + host + ':' + nvr.rtspsPort.toString() + '/' + alias + '?enableSrtp';
}

// Mirrors the override branch: a single rtspEntry built from the highest-resolution channel, pointing at the override URL.
function buildOverrideEntry(ufp: UfpSummary, override: string): { resolution: [number, number, number]; sourceChannel: Channel; url: string } {

  const sourceChannel = [ ...ufp.channels ].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

  return {

    resolution: [ sourceChannel.width, sourceChannel.height, sourceChannel.fps ],
    sourceChannel,
    url: override,
  };
}

describe('ONVIF / third-party RTSP relay host selection', () => {

  const baseChannel: Channel = { fps: 30, height: 1080, isRtspEnabled: true, name: 'High', rtspAlias: 'abc123', width: 1920 };

  it('uses the NVR host when the camera is third-party and reports a null connectionHost', () => {

    // Realistic ONVIF case: Protect leaves connectionHost unset on third-party adoptions.
    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: null, isThirdPartyCamera: true, videoCodec: 'h264' };
    const nvr: NvrSummary = { host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://192.168.5.119:7441/abc123?enableSrtp');
  });

  it('still uses the NVR host for third-party cameras even when connectionHost is the camera\'s own IP', () => {

    // Some controllers populate connectionHost with the camera IP on ONVIF cameras. That host does not listen on the NVR rtsps port, so we must
    // ignore it for third-party cameras and fall back to the NVR.
    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: '192.168.2.100', isThirdPartyCamera: true, videoCodec: 'h264' };
    const nvr: NvrSummary = { host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://192.168.5.119:7441/abc123?enableSrtp');
  });

  it('uses the camera connectionHost for native (non-third-party) cameras', () => {

    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: '192.168.5.10', isThirdPartyCamera: false, videoCodec: 'h264' };
    const nvr: NvrSummary = { host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://192.168.5.10:7441/abc123?enableSrtp');
  });

  it('falls back to the NVR host for native cameras when connectionHost is missing', () => {

    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: null, isThirdPartyCamera: false, videoCodec: 'h264' };
    const nvr: NvrSummary = { host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://192.168.5.119:7441/abc123?enableSrtp');
  });

  it('honors a controller-level overrideAddress regardless of camera type', () => {

    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: '192.168.5.10', isThirdPartyCamera: false, videoCodec: 'h264' };
    const nvr: NvrSummary = { configOverrideAddress: 'protect.example.com', host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://protect.example.com:7441/abc123?enableSrtp');
  });

  it('honors a controller-level overrideAddress even for third-party cameras', () => {

    const ufp: UfpSummary = { channels: [ baseChannel ], connectionHost: '192.168.2.100', isThirdPartyCamera: true, videoCodec: 'h264' };
    const nvr: NvrSummary = { configOverrideAddress: 'protect.example.com', host: '192.168.5.119', rtspsPort: 7441 };

    expect(buildRelayUrl(ufp, nvr, baseChannel.rtspAlias)).toBe('rtsps://protect.example.com:7441/abc123?enableSrtp');
  });
});

describe('RTSP override branch', () => {

  const channels: Channel[] = [

    { fps: 30, height: 360, isRtspEnabled: true, name: 'Low', rtspAlias: 'low', width: 640 },
    { fps: 30, height: 1080, isRtspEnabled: true, name: 'High', rtspAlias: 'high', width: 1920 },
    { fps: 30, height: 720, isRtspEnabled: true, name: 'Medium', rtspAlias: 'med', width: 1280 },
  ];

  it('preserves the override URL verbatim (no ?enableSrtp suffix)', () => {

    const override = 'rtsp://unifi:secret@192.168.2.100:8555/c675d_wide';
    const ufp: UfpSummary = { channels, connectionHost: null, isThirdPartyCamera: true, videoCodec: 'h264' };

    expect(buildOverrideEntry(ufp, override).url).toBe(override);
    expect(buildOverrideEntry(ufp, override).url).not.toContain('?enableSrtp');
  });

  it('selects the highest-resolution channel for the metadata source regardless of channel order', () => {

    const override = 'rtsp://camera/path';
    const ufp: UfpSummary = { channels, connectionHost: null, isThirdPartyCamera: true, videoCodec: 'h264' };

    const entry = buildOverrideEntry(ufp, override);

    expect(entry.sourceChannel.name).toBe('High');
    expect(entry.resolution).toEqual([ 1920, 1080, 30 ]);
  });

  it('accepts both rtsp:// and rtsps:// schemes', () => {

    const ufp: UfpSummary = { channels, connectionHost: null, isThirdPartyCamera: true, videoCodec: 'h264' };

    expect(buildOverrideEntry(ufp, 'rtsp://camera/path').url.startsWith('rtsp://')).toBe(true);
    expect(buildOverrideEntry(ufp, 'rtsps://camera/path').url.startsWith('rtsps://')).toBe(true);
  });
});
