/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-probesize.ts: Adaptive FFmpeg probesize tuning and livestream API error classification for Protect streaming sessions.
 */
import { PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD, PROTECT_FFMPEG_PROBESIZE_MAX, PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT } from './settings.js';
import type { HomebridgePluginLogging } from './lib/index.js';

// Known errors that occur due to occasional inconsistencies in the Protect livestream API.
const TIMESHIFT_LIVESTREAM_ERROR_REGEX = new RegExp([

  '(Cannot determine format of input stream 0:0 after EOF)',
  '(Finishing stream without any data written to it)',
  '(could not find corresponding trex)',
  '(moov atom not found)',
].join('|'));

// Tune the FFmpeg probesize used for a camera, temporarily (or, if it happens often enough, permanently) increasing it when FFmpeg struggles to analyze the
// media stream provided by Protect.
export class ProbesizeTuner {

  private readonly defaultProbesize: () => number;
  private readonly log: HomebridgePluginLogging;
  private override: number;
  private overrideCount: number;
  private overrideTimeout?: NodeJS.Timeout | undefined;

  // Create a tuner. The default probesize is retrieved on demand so that changes to the camera's configuration are always honored.
  constructor(log: HomebridgePluginLogging, defaultProbesize: () => number) {

    this.defaultProbesize = defaultProbesize;
    this.log = log;
    this.override = 0;
    this.overrideCount = 0;
  }

  // FFmpeg error checking when abnormal exits occur so we don't fill logs up with known occasional issues. We're only attentive to the unique errors the
  // livestream API may present when we're using API-based livestreaming.
  public errorCheck(stderrLog: string[], isApiLivestreaming: boolean): string | undefined {

    if(isApiLivestreaming && stderrLog.some(logEntry => TIMESHIFT_LIVESTREAM_ERROR_REGEX.test(logEntry))) {

      return 'FFmpeg ended unexpectedly due to issues processing the media stream provided by the UniFi Protect livestream API. ' +
        'This error can be safely ignored - it will occur occasionally.';
    }

    return undefined;
  }

  // Adjust our probe hints.
  public adjust(): void {

    if(this.overrideTimeout) {

      clearTimeout(this.overrideTimeout);
      this.overrideTimeout = undefined;
    }

    // Maintain statistics on how often we need to adjust our probesize. If this happens too frequently, we will default to a working value.
    this.overrideCount++;

    // Increase the probesize by a factor of two each time we need to do something about it. This idea is to balance the latency implications for the user,
    // but also ensuring we have a functional streaming experience.
    this.override = this.probesize * 2;

    // Safety check to make sure this never gets too crazy.
    if(this.override > PROTECT_FFMPEG_PROBESIZE_MAX) {

      this.override = PROTECT_FFMPEG_PROBESIZE_MAX;
    }

    this.log.error('The FFmpeg process ended unexpectedly due to issues with the media stream provided by the UniFi Protect livestream API. ' +
      'Adjusting the settings we use for FFmpeg %s to use safer values at the expense of some additional streaming startup latency.',
    this.overrideCount < PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD ? 'temporarily' : 'permanently');

    // If this happens often enough, keep the override in place permanently.
    if(this.overrideCount < PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD) {

      this.overrideTimeout = setTimeout(() => {

        this.override = 0;
        this.overrideTimeout = undefined;
      }, PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT);
    }
  }

  // Utility to return the currently set probesize.
  public get probesize(): number {

    return this.override || this.defaultProbesize();
  }
}
