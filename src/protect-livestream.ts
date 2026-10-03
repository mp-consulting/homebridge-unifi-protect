/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 */
import { FfmpegLivestreamProcess, sleep } from './lib/index.js';
import { PROTECT_LIVESTREAM_OFFLINE_RETRY_INTERVAL, PROTECT_LIVESTREAM_RESTART_INTERVAL, PROTECT_LIVESTREAM_TIMEOUT,
  PROTECT_SEGMENT_RESOLUTION } from './settings.js';
import type { ProtectCamera } from './devices/index.js';
import type { ProtectLivestream } from './unifi/index.js';
import type { RtspEntry } from './devices/protect-camera.js';

export class LivestreamManager {

  private eventHandlers: Record<string, () => void>;
  private generation: Record<string, number>;
  private livestreams: Record<string, FfmpegLivestreamProcess | ProtectLivestream>;
  private protectCamera: ProtectCamera;
  private restartCount: number;
  private restartDelay: Record<string, number>;
  private restarting: Record<string, boolean>;
  private subscriberCount: Record<string, number>;
  private segmentTimer: Record<string, NodeJS.Timeout>;
  private startTime: Record<string, number>;

  // Create an instance.
  constructor(protectCamera: ProtectCamera) {

    this.eventHandlers = {};
    this.generation = {};
    this.livestreams = {};
    this.protectCamera = protectCamera;
    this.restartCount = 0;
    this.restartDelay = {};
    this.restarting = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Utility to return an index into our livestream connection pool.
  private getIndex(rtspEntry: RtspEntry): { channel: number; index: string; lens: number | undefined } {

    // If we're using a secondary lens, the channel must always be 0 when using the livestream API.
    const channel = (rtspEntry.lens === undefined) ? rtspEntry.channel.id : 0;
    const lens = rtspEntry.lens;

    return { channel: channel, index: channel.toString() + ((lens !== undefined) ? '.' + lens.toString() : ''), lens: lens };
  }

  // Retrieve a connection to the livestream API for a given channel.
  public acquire(rtspEntry: RtspEntry): FfmpegLivestreamProcess | ProtectLivestream {

    const { index } = this.getIndex(rtspEntry);

    // Let's see if we have an existing livestream already open and reuse it if we can.
    if(this.livestreams[index]) {

      return this.livestreams[index];
    }

    // Create a new livestream instance.
    this.subscriberCount[index] = 0;

    if(this.protectCamera.hasFeature('Debug.Video.HKSV.UseRtsp') && this.protectCamera.stream?.hksv?.recordingConfiguration) {

      return this.livestreams[index] = new FfmpegLivestreamProcess(
        this.protectCamera.stream.ffmpegOptions, this.protectCamera.stream.hksv.recordingConfiguration,
        { codec: this.protectCamera.ufp.videoCodec, enableAudio: this.protectCamera.stream.hksv.isAudioActive, url: rtspEntry.url });
    }

    return this.livestreams[index] = this.protectCamera.nvr.ufpApi.createLivestream();
  }

  // Arm, or re-arm, the watchdog that restarts a livestream session that has stopped delivering segments.
  private armWatchdog(index: string, delay = PROTECT_LIVESTREAM_TIMEOUT, retryRestart = false): void {

    clearTimeout(this.segmentTimer[index]);
    this.segmentTimer[index] = setTimeout(() => this.livestreams[index]?.emit('restart', retryRestart), delay);
  }

  // Restarting status.
  public isRestarting(rtspEntry: RtspEntry): boolean {

    return this.restarting[this.getIndex(rtspEntry).index] ?? false;
  }

  // Shutdown all our connections.
  public shutdown(): void {

    // Cleanup all the listeners and shutdown our livestreams.
    Object.values(this.segmentTimer).forEach(timer => clearTimeout(timer));

    Object.values(this.livestreams).forEach(livestream => {

      livestream.removeAllListeners();
      livestream.stop();
    });

    // Invalidate any restart attempts that are in flight.
    for(const [ index, generation ] of Object.entries(this.generation)) {

      this.generation[index] = generation + 1;
    }

    this.eventHandlers = {};
    this.livestreams = {};
    this.restartDelay = {};
    this.restarting = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Access the livestream API, registering as a consumer.
  public async start(rtspEntry: RtspEntry, segmentLength = PROTECT_SEGMENT_RESOLUTION): Promise<boolean> {

    const { channel, index, lens } = this.getIndex(rtspEntry);

    // If we don't have a livestream configured for this channel, we're done. We could just create it here, but given we listen to events on livestream
    // listeners, this is a safer option to ensure that we've acquired a livestream endpoint before trying to start it.
    if(!this.livestreams[index]) {

      return false;
    }

    // Start the livestream if this is the first run. We set this to reattempt establishing the livestream up to three times due to occasional controller
    // glitches.
    if(!this.subscriberCount[index]) {

      if(this.protectCamera.hasFeature('Debug.Video.HKSV.UseRtsp')) {

        (this.livestreams[index] as FfmpegLivestreamProcess).segmentLength = segmentLength;
        (this.livestreams[index] as FfmpegLivestreamProcess).start();
      } else if(!(await (this.livestreams[index] as ProtectLivestream).start(this.protectCamera.ufp.id, channel,
        { chunkSize: 16384, emitTimestamps: true, lens, requestId: this.protectCamera.name + ':' + index, segmentLength }))) {

        this.protectCamera.log.error('Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting.');

        // Something went wrong in communicating with the controller.
        return false;
      }
    }

    // Keep track of any issues in the livestream.
    if(!this.subscriberCount[index]) {

      this.generation[index] ??= 0;
      this.restartDelay[index] = PROTECT_LIVESTREAM_RESTART_INTERVAL;
      this.restarting[index] = false;
      this.startTime[index] = Date.now();

      // Configure a restart event for the livestream API session so we can restart the session in case of problems. The emitter doesn't await listeners, so
      // the restart runs asynchronously by design.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.livestreams[index].on('restart', this.eventHandlers[index + '.restart'] = async (retryRestart = false): Promise<void> => {

        // If we have a restart inflight and this restart trigger isn't internally triggered, we're done.
        if(this.restarting[index] && !retryRestart) {

          return;
        }

        // Capture the session we're restarting. If the livestream is stopped or shut down while we're waiting, we abandon the restart rather than resurrect a
        // session nobody is consuming anymore.
        const generation = this.generation[index];
        const livestream = this.livestreams[index];

        // The livestream has been shut down out from under us. There's nothing left to restart.
        if(!livestream) {

          return;
        }

        const isStale = (): boolean => (this.generation[index] !== generation) || (this.livestreams[index] !== livestream);

        this.restarting[index] = true;

        // Clear out any existing timer.
        clearTimeout(this.segmentTimer[index]);

        livestream.stop();

        // If either the controller is offline/throttled or the camera isn't connected, let's retry again in a minute.
        if(!this.protectCamera.ufpApi.bootstrap || this.protectCamera.ufpApi.isThrottled || !this.protectCamera.isOnline) {

          this.armWatchdog(index, PROTECT_LIVESTREAM_OFFLINE_RETRY_INTERVAL, true);

          return;
        }

        if(this.protectCamera.hasFeature('Device.SelfHealing') && (++this.restartCount > 10)) {

          this.restartCount = 0;
          this.protectCamera.log.warn("Restarting the camera to reset it's connection to the livestream API.");

          // Restart now.
          const response = await this.protectCamera.nvr.ufpApi.retrieve(this.protectCamera.nvr.ufpApi.getApiEndpoint(this.protectCamera.ufp.modelKey) + '/' +
            this.protectCamera.ufp.id + '/reboot', { body: JSON.stringify({}), method: 'POST' });

          if(isStale()) {

            return;
          }

          // We couldn't reboot the camera. Try again later rather than leaving the livestream permanently marked as restarting.
          if(!this.protectCamera.nvr.ufpApi.responseOk(response?.statusCode)) {

            this.protectCamera.log.error('Unable to restart the camera.');
            this.armWatchdog(index, PROTECT_LIVESTREAM_OFFLINE_RETRY_INTERVAL, true);

            return;
          }
        }

        this.protectCamera.log.warn('Reconnecting to the %s.', this.protectCamera.hasFeature('Debug.Video.HKSV.UseRtsp') ? 'RTSP stream' : 'livestream API');

        // Wait before we try to reconnect to the livestream. This accounts for reboots and other potential connection issues that can occur.
        await sleep((((Math.random() * 3) + (this.restartDelay[index] ?? PROTECT_LIVESTREAM_RESTART_INTERVAL)) * 1000));

        if(isStale()) {

          return;
        }

        if(this.protectCamera.hasFeature('Debug.Video.HKSV.UseRtsp')) {

          (livestream as FfmpegLivestreamProcess).segmentLength = segmentLength;
          (livestream as FfmpegLivestreamProcess).start();
        } else {

          await (livestream as ProtectLivestream).start(this.protectCamera.ufp.id, channel, { lens, requestId: this.protectCamera.name + ':' + index, segmentLength });

          // The session may have been stopped while we were reconnecting. Make sure we don't leave an orphaned connection behind.
          if(isStale()) {

            livestream.stop();

            return;
          }
        }

        this.startTime[index] = Date.now();

        // Check on the state of our livestream API session regularly.
        this.armWatchdog(index);

        // Increase our backoff interval in case we've got a stuck livestream websocket on the Protect controller or the camera is offline.
        this.restartDelay[index] = Math.min((this.restartDelay[index] ?? PROTECT_LIVESTREAM_RESTART_INTERVAL) + (PROTECT_LIVESTREAM_RESTART_INTERVAL / 2),
          PROTECT_LIVESTREAM_RESTART_INTERVAL * 3);

        // We're done with this restart attempt.
        this.restarting[index] = false;
      });

      // Set a regular heartbeat for the livestream API.
      this.livestreams[index].on('segment', this.eventHandlers[index] = (): void => {

        const startTime = this.startTime[index];

        // Make sure we've got a good livestream before we reset our delay.
        if((startTime !== undefined) && ((Date.now() - startTime) > PROTECT_LIVESTREAM_OFFLINE_RETRY_INTERVAL)) {

          this.restartCount = 0;
          this.restartDelay[index] = PROTECT_LIVESTREAM_RESTART_INTERVAL;
        }

        // Push back the watchdog. Segments arrive several times a second, so we re-arm the existing timer rather than allocating a new one each time.
        this.segmentTimer[index]?.refresh();
      });

      // Set an initial timer in case we have an issue with the livestream API at startup.
      this.armWatchdog(index);
    }

    // Increment our consumer count.
    this.subscriberCount[index] = (this.subscriberCount[index] ?? 0) + 1;

    return true;
  }

  // End a livestream API connection once all the consumers of the livestream are done.
  public stop(rtspEntry: RtspEntry): void {

    const { index } = this.getIndex(rtspEntry);

    // If we have open livestreams, we don't want to close the livestream session.
    const remainingSubscribers = (this.subscriberCount[index] ?? 0) - 1;

    this.subscriberCount[index] = remainingSubscribers;

    if(remainingSubscribers > 0) {

      return;
    }

    // Invalidate any restart attempt that's in flight for this session.
    this.generation[index] = (this.generation[index] ?? 0) + 1;

    const livestream = this.livestreams[index];
    const restartHandler = this.eventHandlers[index + '.restart'];
    const segmentHandler = this.eventHandlers[index];

    // End our livestream API connection.
    livestream?.stop();

    // Cleanup our listeners.
    if(restartHandler) {

      livestream?.off('restart', restartHandler);
    }

    if(segmentHandler) {

      livestream?.off('segment', segmentHandler);
    }
    clearTimeout(this.segmentTimer[index]);

    this.subscriberCount[index] = 0;
  }
}
