/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-talkback.test.ts: Tests for two-way audio (talkback) argument and SDP generation.
 */
import { AudioStreamingSamplerate, type StartStreamRequest } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ProtectStreamingDelegate } from '../src/protect-stream.js';
import { ProtectTalkback, type TalkbackSession } from '../src/protect-talkback.js';

// A minimal streaming delegate stand-in covering what talkback touches.
function createDelegate(options: { debugAll?: boolean, direct?: boolean, verbose?: boolean } = {}): ProtectStreamingDelegate {

  return {

    ffmpegOptions: { audioDecoder: 'libfdk_aac', audioEncoder: (): string[] => [ '-codec:a', 'libfdk_aac', '-afterburner', '1' ] },
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    platform: { config: { debugAll: options.debugAll ?? false }, verboseFfmpeg: false },
    protectCamera: {

      accessoryName: 'Front Door',
      hints: { twoWayAudioDirect: options.direct ?? false },
      nvr: { ufpApi: { verifyTls: false } },
      ufp: { host: '192.168.1.20', talkbackSettings: { bindPort: 7004, channels: 1, samplingRate: 22050 } },
    },
    verboseFfmpeg: options.verbose ?? false,
  } as unknown as ProtectStreamingDelegate;
}

function createRequest(sampleRate = AudioStreamingSamplerate.KHZ_16): StartStreamRequest {

  return { audio: { channel: 1, max_bit_rate: 24, pt: 110, sample_rate: sampleRate }, sessionID: 'session-1' } as unknown as StartStreamRequest;
}

const session: TalkbackSession = {

  address: '192.168.1.50',
  audioIncomingRtpPort: 50000,
  audioSRTP: Buffer.from('0123456789abcdef0123456789abcd'),
  rtpDemuxer: null,
  talkBack: null,
};

describe('ProtectTalkback', () => {

  it('builds an SDP description for a 16 kHz session', () => {

    const sdp = new ProtectTalkback(createDelegate()).buildSdpResponse(createRequest(), session, 'IP4').split('\n');

    expect(sdp).toEqual([

      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Front Door Audio Talkback',
      'c=IN IP4 192.168.1.50',
      't=0 0',
      'm=audio 50000 RTP/AVP 110',
      'b=AS:24',
      'a=rtpmap:110 MPEG4-GENERIC/16000/1',
      'a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00',
      'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + session.audioSRTP.toString('base64'),
    ]);
  });

  it('builds an SDP description for a 24 kHz IPv6 session', () => {

    const sdp = new ProtectTalkback(createDelegate()).buildSdpResponse(createRequest(AudioStreamingSamplerate.KHZ_24), session, 'IP6');

    expect(sdp).toContain('c=IN IP6 192.168.1.50');
    expect(sdp).toContain('a=rtpmap:110 MPEG4-GENERIC/24000/1');
    expect(sdp).toContain('config=F8EC212C00BC00');
  });

  it('builds return audio arguments that pipe through the Protect controller', () => {

    expect(new ProtectTalkback(createDelegate()).buildReturnAudioArgs(createRequest())).toEqual([

      '-hide_banner', '-nostats', '-protocol_whitelist', 'crypto,file,pipe,rtp,udp', '-f', 'sdp', '-codec:a', 'libfdk_aac', '-i', 'pipe:0',
      '-map', '0:a:0', '-codec:a', 'libfdk_aac', '-afterburner', '1', '-flags', '+global_header', '-ar', '22050', '-b:a', '24k', '-ac', '1',
      '-f', 'adts', 'pipe:1',
    ]);
  });

  it('sends return audio directly to the camera and adds logging when requested', () => {

    const args = new ProtectTalkback(createDelegate({ debugAll: true, direct: true, verbose: true })).buildReturnAudioArgs(createRequest());

    expect(args.slice(-5)).toEqual([ 'udp://192.168.1.20:7004', '-loglevel', 'level+verbose', '-loglevel', 'level+debug' ]);
  });

  it('does not start FFmpeg if the RTP demuxer has closed before audio arrives', async () => {

    const demuxer = Object.assign(new EventEmitter(), { isRunning: false });
    const registerProcess = vi.fn();
    const started = new ProtectTalkback(createDelegate({ direct: true })).start(createRequest(),
      { ...session, rtpDemuxer: demuxer as unknown as TalkbackSession['rtpDemuxer'] }, 'IP4', registerProcess);

    demuxer.emit('rtp');
    await started;

    expect(registerProcess).not.toHaveBeenCalled();
  });
});
