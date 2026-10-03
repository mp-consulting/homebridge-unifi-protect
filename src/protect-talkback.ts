/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-talkback.ts: Two-way audio (talkback) support for Protect camera livestreams.
 */
import { AudioStreamingSamplerate, type StartStreamRequest } from 'homebridge';
import { FfmpegStreamingProcess, type HomebridgePluginLogging, type Nullable, type RtpDemuxer, WebSocketClient } from './lib/index.js';
import type { ProtectStreamingDelegate } from './protect-stream.js';
import { once } from 'node:events';

// The subset of a streaming session's state that talkback needs.
export interface TalkbackSession {

  address: string; // Address of the HomeKit client.
  audioIncomingRtpPort: number; // Port to receive audio from the HomeKit microphone.
  audioSRTP: Buffer;
  rtpDemuxer: Nullable<RtpDemuxer>; // RTP demuxer needed for two-way audio.
  talkBack: Nullable<string>; // Talkback websocket needed for two-way audio.
}

// Manage the return audio channel from HomeKit to a Protect camera, either through the Protect controller's talkback websocket or directly to the camera.
export class ProtectTalkback {

  private readonly delegate: ProtectStreamingDelegate;
  private readonly log: HomebridgePluginLogging;

  // Create a talkback handler for a streaming delegate.
  constructor(delegate: ProtectStreamingDelegate) {

    this.delegate = delegate;
    this.log = delegate.log;
  }

  // Start two-way audio for a streaming session. Any FFmpeg process we start is handed to registerProcess for session housekeeping.
  public async start(request: StartStreamRequest, session: TalkbackSession, sdpIpVersion: string,
    registerProcess: (process: FfmpegStreamingProcess) => void): Promise<void> {

    await this.startReturnAudio(request, session, this.buildSdpResponse(request, session, sdpIpVersion), this.buildReturnAudioArgs(request), registerProcess);
  }

  // Generate the SDP response for HomeKit two-way audio.
  public buildSdpResponse(request: StartStreamRequest, session: TalkbackSession, sdpIpVersion: string): string {

    // Session description protocol message that FFmpeg will share with HomeKit.
    // SDP messages tell the other side of the connection what we're expecting to receive.
    //
    // Parameters are:
    //
    // v             Protocol version - always 0.
    // o             Originator and session identifier.
    // s             Session description.
    // c             Connection information.
    // t             Timestamps for the start and end of the session.
    // m             Media type - audio, adhering to RTP/AVP, payload type 110.
    // b             Bandwidth information - application specific, 16k or 24k.
    // a=rtpmap      Payload type 110 corresponds to an MP4 stream. Format is MPEG4-GENERIC/<audio clock rate>/<audio channels>
    // a=fmtp        For payload type 110, use these format parameters.
    // a=crypto      Crypto suite to use for this session.
    return [

      'v=0',
      'o=- 0 0 IN ' + sdpIpVersion + ' 127.0.0.1',
      's=' + this.delegate.protectCamera.accessoryName + ' Audio Talkback',
      'c=IN ' + sdpIpVersion + ' ' + session.address,
      't=0 0',
      'm=audio ' + session.audioIncomingRtpPort.toString() + ' RTP/AVP ' + request.audio.pt.toString(),
      'b=AS:24',
      'a=rtpmap:110 MPEG4-GENERIC/' +
        ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? '16000' : '24000') + '/' + request.audio.channel.toString(),
      'a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=' +
        ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? 'F8F0212C00BC00' : 'F8EC212C00BC00'),
      'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + session.audioSRTP.toString('base64'),
    ].join('\n');
  }

  // Construct FFmpeg return audio arguments for two-way audio.
  public buildReturnAudioArgs(request: StartStreamRequest): string[] {

    const protectCamera = this.delegate.protectCamera;

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports the audio codecs we need. Options we use are:
    //
    // -hide_banner           Suppress printing the startup banner in FFmpeg.
    // -nostats               Suppress printing progress reports while encoding in FFmpeg.
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -codec:a               Decode AAC input using the specified decoder.
    // -i pipe:0              Read input from standard input.
    // -codec:a               Encode to AAC. This format is set by Protect.
    // -flags +global_header  Sets the global header in the bitstream.
    // -ar                    Sets the audio rate to what Protect is expecting.
    // -b:a                   Bitrate to use for this audio stream based on what HomeKit is providing us.
    // -ac                    Sets the channel layout of the audio stream based on what Protect is expecting.
    // -f adts                Transmit an ADTS stream.
    // pipe:1                 Output the ADTS stream to standard output.
    const ffmpegReturnAudioCmd = [

      '-hide_banner',
      '-nostats',
      '-protocol_whitelist', 'crypto,file,pipe,rtp,udp',
      '-f', 'sdp',
      '-codec:a', this.delegate.ffmpegOptions.audioDecoder,
      '-i', 'pipe:0',
      '-map', '0:a:0',
      ...this.delegate.ffmpegOptions.audioEncoder(),
      '-flags', '+global_header',
      '-ar', protectCamera.ufp.talkbackSettings.samplingRate.toString(),
      '-b:a', request.audio.max_bit_rate.toString() + 'k',
      '-ac', protectCamera.ufp.talkbackSettings.channels.toString(),
      '-f', 'adts',
    ];

    if(protectCamera.hints.twoWayAudioDirect) {

      ffmpegReturnAudioCmd.push('udp://' + protectCamera.ufp.host + ':' + protectCamera.ufp.talkbackSettings.bindPort.toString());
    } else {

      ffmpegReturnAudioCmd.push('pipe:1');
    }

    // Additional logging, but only if we're debugging.
    if(this.delegate.platform.verboseFfmpeg || this.delegate.verboseFfmpeg) {

      ffmpegReturnAudioCmd.push('-loglevel', 'level+verbose');
    }

    if(this.delegate.platform.config.debugAll) {

      ffmpegReturnAudioCmd.push('-loglevel', 'level+debug');
    }

    return ffmpegReturnAudioCmd;
  }

  // Start the return audio FFmpeg process and handle two-way audio talkback via websocket.
  private async startReturnAudio(request: StartStreamRequest, session: TalkbackSession, sdpReturnAudio: string, ffmpegReturnAudioCmd: string[],
    registerProcess: (process: FfmpegStreamingProcess) => void): Promise<void> {

    const protectCamera = this.delegate.protectCamera;

    try {

      // Now it's time to talkback.
      let ws: Nullable<WebSocketClient> = null;
      let isTalkbackLive = false;
      let dataListener: (data: Buffer) => void;
      let openListener: () => void;
      const wsCleanup = (): void => {

        // Close the websocket.
        if(ws?.readyState !== WebSocketClient.CLOSED) {

          ws?.close();
        }
      };

      if(session.talkBack && !protectCamera.hints.twoWayAudioDirect) {

        // Open the talkback connection. Certificate validation follows the API's verifyTls setting, which defaults to off since Protect controllers ship with
        // self-signed certificates.
        ws = new WebSocketClient(session.talkBack, { agent: protectCamera.nvr.ufpApi.tlsAgent, rejectUnauthorized: protectCamera.nvr.ufpApi.verifyTls });
        isTalkbackLive = true;

        // Catch any errors and inform the user, if needed.
        ws.once('error', (error: Error) => {

          // Ignore timeout errors and TypeErrors, but notify the user about anything else.
          if(!(error instanceof TypeError) && ((error as NodeJS.ErrnoException).code !== 'ETIMEDOUT')) {

            this.log.error('Error in communicating with the return audio channel: %s - %s', (error as NodeJS.ErrnoException).code, error.message);
          }

          // Clean up our talkback websocket.
          wsCleanup();
        });

        // Catch any stray open events after we've closed.
        ws.on('open', openListener = (): void => {

          // If we've somehow opened after we've wrapped up talkback, terminate the connection.
          if(!isTalkbackLive) {

            // Clean up our talkback websocket.
            wsCleanup();
          }
        });

        // Cleanup after ourselves on close.
        ws.once('close', () => {

          ws?.removeListener('open', openListener);
        });
      }

      // Wait for the first RTP packet to be received before trying to launch FFmpeg.
      if(session.rtpDemuxer) {

        await once(session.rtpDemuxer, 'rtp');

        // If we've already closed the RTP demuxer, we're done here,
        if(!session.rtpDemuxer.isRunning) {

          // Clean up our talkback websocket.
          wsCleanup();

          return;
        }
      }

      // Fire up FFmpeg and start processing the incoming audio.
      const ffmpegReturnAudio = new FfmpegStreamingProcess(this.delegate, request.sessionID, this.delegate.ffmpegOptions, ffmpegReturnAudioCmd);

      // Setup housekeeping for the twoway FFmpeg session.
      registerProcess(ffmpegReturnAudio);

      // Feed the SDP session description to FFmpeg on stdin.
      ffmpegReturnAudio.stdin?.end(sdpReturnAudio + '\n');

      // Send the audio, if we're communicating through the Protect controller. Otherwise, FFmpeg is handling this directly with the camera.
      if(!protectCamera.hints.twoWayAudioDirect) {

        ffmpegReturnAudio.stdout?.on('data', dataListener = (data: Buffer): void => ws?.send(data));

        // Make sure we terminate the talkback websocket when we're done.
        ffmpegReturnAudio.ffmpegProcess?.once('exit', () => {

          // Make sure we catch any stray connections that may be too slow to open.
          isTalkbackLive = false;

          // Clean up our talkback websocket.
          wsCleanup();

          ffmpegReturnAudio.stdout?.off('data', dataListener);
        });
      }
    } catch(error) {

      this.log.error('Unable to connect to the return audio channel: %s', error);
    }
  }
}
