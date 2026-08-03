/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-snapshot.ts: UniFi Protect HomeKit snapshot class.
 */
import type { API, HAP, SnapshotRequest } from 'homebridge';
import { FfmpegExec, type HomebridgePluginLogging, type Nullable, request, runWithTimeout } from './lib/index.js';
import https from 'node:https';
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_SNAPSHOT_CACHE_MAXAGE, PROTECT_SNAPSHOT_FALLBACK_RESERVE, PROTECT_SNAPSHOT_TIMEOUT } from './settings.js';
import type { ProtectCamera } from './devices/index.js';
import type { ProtectNvr } from './protect-nvr.js';
import type { ProtectPlatform } from './protect-platform.js';

// Camera snapshot class for Protect.
export class ProtectSnapshot {

  private _cachedSnapshot: Nullable<{ image: Buffer; time: number }>;
  private readonly api: API;
  private readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private readonly pendingSnapshots: Map<string, Promise<Nullable<Buffer>>>;
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera) {

    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.pendingSnapshots = new Map();
    this.protectCamera = protectCamera;
    this.platform = protectCamera.platform;
    this._cachedSnapshot = null;
  }

  // Return a snapshot for use by HomeKit.
  public async getSnapshot(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't connected, we're done.
    if(!this.protectCamera.ufpApi.bootstrap || this.protectCamera.ufpApi.isThrottled || !this.protectCamera.isOnline) {

      return null;
    }

    // See if we have an image cached that we can use, if needed.
    const cachedSnapshot = this.cachedSnapshot;

    // The deadline for this request. Each snapshot source we try is bounded against it so that a slow source can't consume the entire budget and leave us
    // with nothing to show for it.
    const deadline = Date.now() + PROTECT_SNAPSHOT_TIMEOUT;

    // HomeKit will happily ask for the same image several times over - opening the Home app requests a snapshot for every camera tile, and a doorbell ring
    // adds more on top of that. Coalescing identical in-flight requests means we spawn one FFmpeg instance instead of several that compete with each other
    // for the same RTSP stream and CPU. We key on the requested dimensions so that callers always get an image scaled the way they asked for it.
    const requestKey = request ? (request.width.toString() + 'x' + request.height.toString()) : 'default';
    const pending = this.pendingSnapshots.get(requestKey);

    if(pending) {

      const shared = await runWithTimeout(pending, PROTECT_SNAPSHOT_TIMEOUT);

      return shared ?? this.snapshotFallback(cachedSnapshot);
    }

    // We request the snapshot to prioritize performance and quality of the image. The reason for this is that the Protect API constrains the quality level
    // of snapshot images and doesn't always produce them reliably. Fortunately, we have a few options. We retrieve snapshots by trying to use the following
    // sources, in order:
    //
    // - Timeshift buffer   eliminates querying the Protect controller and allows us to capture the highest quality image we can.
    // - RTSP stream        queries the Protect controller, but allows us to capture the highest quality image available.
    // - Protect API        requests a snapshot from the Protect controller. This is an error-prone task for the Protect controller and produces lower quality
    //                      images.
    // - Cached snapshot    returns the last snapshot we have taken, assuming it isn't too old.
    //
    // The exception to this is package cameras - we try the Protect API before the RTSP stream there because the lower frame rate of the camera causes
    // a lengthier response time.
    const snapshotPromise = (async (): Promise<Nullable<Buffer>> => {

      // If a snapshot URL override is configured (typically for ONVIF and other third-party cameras), prefer it - the Protect controller's snapshot
      // API does not work reliably for these devices.
      let snapAttempt = await this.snapFromUrlOverride();

      if(!snapAttempt) {

        // The timeshift buffer still has both the RTSP stream and the controller API queued up behind it.
        snapAttempt = await this.snapFromTimeshift(this.sourceBudget(deadline, true), request);
      }

      // No snapshot yet, let's try again. Each source is bounded to the time we have left, holding back a reserve for whatever follows it so that a slow
      // source can't consume the whole budget and leave its fallback with nothing.
      if(!snapAttempt) {

        // We treat package cameras uniquely.
        if('packageCamera' in this.protectCamera.accessory.context) {

          snapAttempt = (await this.snapFromApi(this.sourceBudget(deadline, true), true, request)) ??
            (await this.snapFromRtsp(this.sourceBudget(deadline, false), request));
        } else {

          snapAttempt = (await this.snapFromRtsp(this.sourceBudget(deadline, true), request)) ??
            (await this.snapFromApi(this.sourceBudget(deadline, false), false, request));
        }
      }

      if(!snapAttempt) {

        return null;
      }

      // Crop the snapshot, if we're configured to do so.
      if(this.protectCamera.hints.crop) {

        const cropped = await this.cropSnapshot(snapAttempt, this.sourceBudget(deadline, false));

        // Cropping is often used to keep something out of frame deliberately, so falling back to the full image isn't something to do quietly.
        if(!cropped) {

          this.log.warn('Unable to crop this snapshot: returning the uncropped image instead.');
        }

        snapAttempt = cropped ?? snapAttempt;
      }

      // Cache the image before returning it.
      this._cachedSnapshot = { image: snapAttempt, time: Date.now() };

      return snapAttempt;
    })();

    // Publish this attempt so that concurrent requests for the same dimensions can ride along with it rather than starting their own.
    this.pendingSnapshots.set(requestKey, snapshotPromise);

    // Get a snapshot, but ensure we constrain it so we can return in a responsive manner. We clear our in-flight entry when the underlying work actually
    // finishes rather than when we time out, so a request that overruns its budget doesn't get duplicated by the next caller.
    const snapshot = await runWithTimeout(snapshotPromise.finally(() => {

      if(this.pendingSnapshots.get(requestKey) === snapshotPromise) {

        this.pendingSnapshots.delete(requestKey);
      }
    }), PROTECT_SNAPSHOT_TIMEOUT);

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if one is already inflight or if it's too soon after the
    // last one.
    if(!snapshot) {

      return this.snapshotFallback(cachedSnapshot);
    }

    return snapshot;
  }

  // Fall back to the most recent cached image when we can't produce a fresh snapshot.
  private snapshotFallback(cachedSnapshot: Nullable<Buffer>): Nullable<Buffer> {

    if(cachedSnapshot) {

      this.log.warn('Unable to retrieve a snapshot: using the most recent cached snapshot instead.');

      return cachedSnapshot;
    }

    this.log.error('Unable to retrieve a snapshot.');

    return null;
  }

  // Snapshots fetched directly from a user-provided URL on the camera, bypassing the Protect controller. Used for ONVIF and other third-party
  // cameras that expose their own snapshot endpoint.
  private async snapFromUrlOverride(): Promise<Nullable<Buffer>> {

    const overrideUrl = this.protectCamera.hints.snapshotUrlOverride;

    if(!overrideUrl) {

      return null;
    }

    try {

      // Allow self-signed certificates - third-party cameras commonly serve HTTPS with non-public certs.
      const agent = overrideUrl.startsWith('https://') ?
        new https.Agent({ rejectUnauthorized: false }) :
        undefined;

      const { statusCode, body } = await request(overrideUrl, {

        agent,
        method: 'GET',
        signal: AbortSignal.timeout(PROTECT_SNAPSHOT_TIMEOUT),
      });

      if(statusCode !== 200) {

        this.log.warn('Snapshot URL override returned HTTP %s.', statusCode);

        return null;
      }

      return Buffer.from(await body.arrayBuffer());
    } catch(error) {

      this.log.warn('Snapshot URL override request failed: %s.', error instanceof Error ? error.message : String(error));

      return null;
    }
  }

  // How long a snapshot source may run, given our overall deadline. When something is still queued up behind it we hold back a reserve so that source gets
  // a turn rather than being starved by whatever ran ahead of it. A non-positive result means there's no time left to try this source at all.
  private sourceBudget(deadline: number, hasFallback: boolean): number {

    return deadline - Date.now() - (hasFallback ? PROTECT_SNAPSHOT_FALLBACK_RESERVE : 0);
  }

  // Snapshots generated on demand by the Protect controller. Lower quality than the FFmpeg-based sources, but far quicker, which makes it our fallback.
  private async snapFromApi(budget: number, usePackageCamera: boolean, request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // Out of time - calling the controller now would only guarantee an abort and an error in the log.
    if(budget <= 0) {

      return null;
    }

    return this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, { height: request?.height, timeout: budget, usePackageCamera, width: request?.width });
  }

  // Snapshots using the timeshift buffer as the source.
  private async snapFromTimeshift(budget: number, request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.stream || !this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    const buffer = this.protectCamera.stream.hksv?.timeshift.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000);

    if(!buffer) {

      return null;
    }

    // Use our timeshift buffer to create a snapshot image. Options we use are:
    //
    // -r fps                     Set the input frame rate for the video stream.
    // -probesize number          How many bytes should be analyzed for stream information.
    // -f mp4                     Specify that our input will be an MP4 file.
    // -i pipe:0                  Read input from standard input.
    const ffmpegOptions = [

      '-r', this.protectCamera.stream.hksv?.rtspEntry?.channel.fps.toString() ?? '30',
      '-probesize', buffer.length.toString(),
      '-f', 'mp4',
      '-i', 'pipe:0',
    ];

    return this.snapFromFfmpeg(ffmpegOptions, budget, request, buffer);
  }

  // Snapshots using the Protect RTSP endpoints as the source.
  private async snapFromRtsp(budget: number, request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.stream || !this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    // Grab the highest quality stream we have available.
    const rtspEntry = this.protectCamera.findRtsp(3840, 2160, { biasHigher: true });

    if(!rtspEntry) {

      return null;
    }

    // Use the RTSP stream to generate a snapshot image. Options we use are:
    //
    // -avioflags direct          Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
    // -r fps                     Set the input frame rate for the video stream.
    // -probesize number          How many bytes should be analyzed for stream information.
    // -rtsp_transport tcp        Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i rtspEntry.url           RTSPS URL to get our input stream from.
    const ffmpegOptions = [

      '-avioflags', 'direct',
      '-r', rtspEntry.channel.fps.toString(),
      '-probesize', this.protectCamera.stream.probesize.toString(),
      '-rtsp_transport', 'tcp',
      '-i', rtspEntry.url,
    ];

    return this.snapFromFfmpeg(ffmpegOptions, budget, request);
  }

  // Generate a snapshot using FFmpeg.
  private async snapFromFfmpeg(ffmpegInputOptions: string[], budget: number, request?: SnapshotRequest, buffer?: Buffer): Promise<Nullable<Buffer>> {

    // If there's no time left in our budget, don't start something we can't finish - our fallback is a better use of what remains.
    if(!this.protectCamera.stream || (budget <= 0)) {

      return null;
    }

    // Options we use to generate an image based on our MP4 input are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags        Set the format flags to generate a presentation timestamp if it's missing and discard any corrupt packets rather than exit.
    // -max_delay 500000    Set an upper limit on how much time FFmpeg can take in demuxing packets.
    // -flags low_delay     Tell FFmpeg to optimize for low delay / realtime decoding.
    // -skip_frame          Only decode and process I-frames to ensure we always get a complete image when taking a snapshot.
    // -fps_mode vfr        Ensure we deal with any variable frame rates that might occur.
    // -frames:v 1          Extract a single video frame for the output.
    // -q:v 2               Set the quality output of the JPEG output.
    const commandLineOptions = [

      '-hide_banner',
      '-nostats',
      '-fflags', '+discardcorrupt+genpts',
      ...this.protectCamera.stream.ffmpegOptions.videoDecoder(this.protectCamera.ufp.videoCodec),
      '-max_delay', '500000',
      '-flags', 'low_delay',
      '-skip_frame', 'nointra',
      ...ffmpegInputOptions,
      '-fps_mode', 'vfr',
      '-frames:v', '1',
      '-q:v', '2',
    ];

    // If we've specified dimensions, scale the snapshot.
    if(request) {

      // Video filter options we use for -filter:v are:
      //
      // select             Select only keyframes. These will be full images and avoid potential image corruption, especially in HEVC use cases.
      // scale=             Scale the image down, if needed, but never upscale it, preserving aspect ratios and letterboxing where needed.
      commandLineOptions.push('-filter:v', [

        (this.protectCamera.stream.ffmpegOptions.videoDecoder(this.protectCamera.ufp.videoCodec).some(decoder => [ 'h264_qsv', 'hevc_qsv' ].includes(decoder)) ?
          'hwdownload,format=nv12,' : '') +
        'scale=' + request.width.toString(), request.height.toString(),
        'force_original_aspect_ratio=decrease,pad=' + request.width.toString(), request.height.toString(),
        '(ow-iw)/2', '(oh-ih)/2',
      ].join(':'));
    }

    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the snapshot to standard output.
    commandLineOptions.push(

      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      'pipe:1',
    );

    // Enable verbose logging, if we're debugging.
    if(this.protectCamera.hasFeature('Debug.Video.Snapshot')) {

      commandLineOptions.unshift('-loglevel', 'level+verbose');
    }

    // Instantiate FFmpeg.
    const ffmpeg = new FfmpegExec(this.protectCamera.stream.ffmpegOptions, commandLineOptions, false);

    // Retrieve the snapshot, bounded by whatever's left of our budget. FFmpeg gets killed if it overruns, which keeps a stalled RTSP session from lingering
    // long after we've given up on it and starving subsequent snapshot attempts of CPU.
    const ffmpegResult = await ffmpeg.exec(buffer, budget);

    // We're done. If we produced an empty image, we couldn't utilize the output.
    if(ffmpegResult?.exitCode === 0) {

      return ffmpegResult.stdout.length ? ffmpegResult.stdout : null;
    }

    return null;
  }

  // Image snapshot crop handler.
  private async cropSnapshot(snapshot: Buffer, budget: number): Promise<Nullable<Buffer>> {

    // Cropping is the last thing we do, so it gets whatever's left of the budget - there's nothing behind it to reserve time for.
    if(!this.protectCamera.stream || (budget <= 0)) {

      return null;
    }

    // Crop the snapshot using the FFmpeg with crop filter. Options we use are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -i pipe:0            Read input from standard input.
    // -filter:v            Pass the crop filter options to FFmpeg.
    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the cropped snapshot to standard output.
    const ffmpeg = new FfmpegExec(this.protectCamera.stream.ffmpegOptions, [

      '-hide_banner',
      '-nostats',
      '-fflags', '+discardcorrupt+genpts',
      ...this.protectCamera.stream.ffmpegOptions.videoDecoder(this.protectCamera.ufp.videoCodec),
      '-max_delay', '500000',
      '-flags', 'low_delay',
      '-i', 'pipe:0',
      '-filter:v', this.protectCamera.stream.ffmpegOptions.cropFilter,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      'pipe:1',
    ]);

    // Retrieve the snapshot.
    const ffmpegResult = await ffmpeg.exec(snapshot, budget);

    // Crop succeeded, we're done. Our caller reports the failure case, since it's the one that decides what to do about it.
    return (ffmpegResult?.exitCode === 0) ? ffmpegResult.stdout : null;
  }

  // Retrieve a cached snapshot, if available.
  private get cachedSnapshot(): Nullable<Buffer> {

    // If we have an image from the last few seconds, we can use it. Otherwise, we're done.
    if(!this._cachedSnapshot || ((Date.now() - this._cachedSnapshot.time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      this._cachedSnapshot = null;

      return null;
    }

    return this._cachedSnapshot.image;
  }
}
