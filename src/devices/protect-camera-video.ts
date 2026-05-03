/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-camera-video.ts: Video stream management delegate for UniFi Protect cameras.
 */
import type { Nullable } from 'homebridge-plugin-utils';
import type { ProtectCamera, RtspEntry } from './protect-camera.js';
import { formatResolution } from './protect-camera.js';
import { ProtectStreamingDelegate } from '../protect-stream.js';
import { toCamelCase } from '../protect-utils.js';

// Options for tuning our RTSP lookups.
type RtspOptions = Partial<{

  biasHigher: boolean;
  default: string;
  maxPixels: number;
  rtspEntries: RtspEntry[];
}>;

// Sort RTSP entries by resolution from highest to lowest.
function sortByResolutions(a: RtspEntry, b: RtspEntry): number {

  return (b.resolution[0] - a.resolution[0]) || (b.resolution[1] - a.resolution[1]) || (b.resolution[2] - a.resolution[2]);
}

export class ProtectCameraVideo {

  private readonly camera: ProtectCamera;
  private rtspEntries: RtspEntry[];

  constructor(camera: ProtectCamera) {

    this.camera = camera;
    this.rtspEntries = [];
  }

  // Configure the video stream for HomeKit.
  public async configure(): Promise<boolean> {

    const rtspEntries: RtspEntry[] = [];
    const rtspOverride = this.camera.hints.rtspOverride;

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!this.camera.ufp.channels.length) {

      this.camera.log.warn('No camera channel metadata available from the Protect controller. ' +
        'Streaming cannot be configured for this camera. This typically means the camera has not finished initializing on the controller, ' +
        'or that the local Protect user this plugin is configured with lacks an admin role.');

      return false;
    }

    // If a per-camera RTSP override URL is configured, build a single RTSP entry from it and skip the controller-side relay setup. This is the only
    // viable streaming path for ONVIF and other third-party cameras that the Protect controller does not actually relay over its RTSPS endpoint,
    // despite reporting isRtspEnabled on each channel.
    if(rtspOverride) {

      // Use the highest-resolution channel reported by the Protect controller as the metadata source for HomeKit. The override URL itself is the
      // single source of pixels regardless of which channel HomeKit asks for.
      const sourceChannel = [ ...this.camera.ufp.channels ].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!sourceChannel.name || (sourceChannel.width <= 0) || (sourceChannel.width > 65535) || (sourceChannel.height <= 0) ||
        (sourceChannel.height > 65535)) {

        this.camera.log.warn('RTSP override is set but the camera channels report invalid resolutions. Streaming cannot be configured.');

        return false;
      }

      rtspEntries.push({

        channel: sourceChannel,
        name: formatResolution([ sourceChannel.width, sourceChannel.height, sourceChannel.fps ]) + ' (Override) [' +
          ((this.camera.ufp.videoCodec || 'h264').replace('h265', 'hevc')).toUpperCase() + ']',
        resolution: [ sourceChannel.width, sourceChannel.height, sourceChannel.fps ],
        url: rtspOverride,
      });

      this.camera.log.info('Using a custom RTSP URL for livestreams. The Protect controller will not be used to relay this stream.');
    } else {

      // Enable RTSP on the camera if needed and get the list of RTSP streams we have ultimately configured.
      this.camera.ufp = await this.camera.nvr.ufpApi.enableRtsp(this.camera.ufp) ?? this.camera.ufp;

      // Figure out which camera channels are RTSP-enabled, and user-enabled. We also filter out any package camera entries. We deal with those
      // independently elsewhere.
      const cameraChannels = this.camera.ufp.channels.filter(channel => channel.isRtspEnabled && (channel.name !== 'Package Camera'));

      // For ONVIF and other third-party cameras, the controller's RTSPS relay frequently isn't usable even when isRtspEnabled is reported on
      // every channel. Surface a hint so users know about the override option instead of silently failing.
      if(this.camera.ufp.isThirdPartyCamera) {

        this.camera.log.warn('Third-party camera detected without an RTSP override URL. The Protect controller often does not relay third-party ' +
          'camera streams successfully. If livestreams fail to render in HomeKit, set the Video.Stream.RtspOverride feature option to the ' +
          "camera's native RTSP(S) URL (see docs/onvif-camera-support.md).");
      }

      // Set the camera and shapshot URLs.
      const cameraUrl = 'rtsps://' +
        (this.camera.nvr.config.overrideAddress ??
          (this.camera.ufp.isThirdPartyCamera ? this.camera.nvr.ufp.host : this.camera.ufp.connectionHost) ??
          this.camera.nvr.ufp.host) + ':' +
        this.camera.nvr.ufp.ports.rtsps.toString() + '/';

      // No RTSP streams are available that meet our criteria - we're done.
      if(!cameraChannels.length) {

        this.camera.log.info('No RTSP profiles found for this camera. ' +
          'Enable at least one RTSP profile in the UniFi Protect webUI or assign an admin role to the local Protect user you configured for use ' +
          'with this plugin.');

        return false;
      }

      // Now that we have our RTSP streams, create a list of supported resolutions for HomeKit.
      for(const channel of cameraChannels) {

        // Sanity check in case Protect reports nonsensical resolutions.
        if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

          continue;
        }

        rtspEntries.push({

          channel: channel,
          name: formatResolution([ channel.width, channel.height, channel.fps ]) + ' (' + channel.name + ') [' +
            (this.camera.ufp.videoCodec.replace('h265', 'hevc')).toUpperCase() + ']',
          resolution: [ channel.width, channel.height, channel.fps ],
          url: cameraUrl + channel.rtspAlias + '?enableSrtp',
        });
      }
    }

    // No RTSP entries were produced (channels reported all-invalid resolutions). Bail rather than continue with an empty list.
    if(!rtspEntries.length) {

      this.camera.log.warn('No usable RTSP streams could be derived for this camera. Streaming cannot be configured.');

      return false;
    }

    // Sort the list of resolutions, from high to low.
    rtspEntries.sort(sortByResolutions);

    let validResolutions;

    // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch, while respecting aspect
    // ratios. We use the frame rate of the first entry, which should be our highest resolution option that's native to the camera as the upper bound
    // for frame rate.
    //
    // Our supported resolutions range from 4K through 320p.
    if((rtspEntries[0].resolution[0] / rtspEntries[0].resolution[1]) === (4 / 3)) {

      validResolutions = [

        [ 3840, 2880 ], [ 2560, 1920 ],
        [ 1920, 1440 ], [ 1280, 960 ],
        [ 640, 480 ], [ 480, 360 ],
        [ 320, 240 ],
      ];
    } else {

      validResolutions = [

        [ 3840, 2160 ], [ 2560, 1440 ],
        [ 1920, 1080 ], [ 1280, 720 ],
        [ 640, 360 ], [ 480, 270 ],
        [ 320, 180 ],
      ];
    }

    // Generate a list of valid resolutions that support both 30 and 15fps.
    validResolutions = validResolutions.flatMap(([ width, height ]) => [ 30, 15 ].map(fps => [ width, height, fps ]));

    // Validate and add our entries to the list of what we make available to HomeKit. We map these resolutions to the channels we have available to us
    // on the camera.
    for(const entry of validResolutions) {

      // This resolution is larger than the highest resolution on the camera, natively. We make an exception for 1080p and 720p resolutions since
      // HomeKit explicitly requires them.
      if((entry[0] >= rtspEntries[0].resolution[0]) && ![ 1920, 1280 ].includes(entry[0])) {

        continue;
      }

      // Find the closest RTSP match for this resolution.
      const foundRtsp = this.findRtsp(entry[0], entry[1], { rtspEntries: rtspEntries });

      if(!foundRtsp) {

        continue;
      }

      // We already have this resolution in our list.
      if(rtspEntries.some(x => (x.resolution[0] === entry[0]) && (x.resolution[1] === entry[1]) && (x.resolution[2] === foundRtsp.channel.fps))) {

        continue;
      }

      // Add the resolution to the list of supported resolutions, but use the selected camera channel's native frame rate.
      rtspEntries.push({ channel: foundRtsp.channel, name: foundRtsp.name, resolution: [ entry[0], entry[1], foundRtsp.channel.fps ], url: foundRtsp.url });
    }

    // Sort resolutions from high to low once after all entries have been added.
    rtspEntries.sort(sortByResolutions);

    // Ensure we've got at least one entry that can be used for HomeKit Secure Video. Some Protect cameras (e.g. G3 Flex) don't have a native frame
    // rate that maps to HomeKit's specific requirements for event recording, so we ensure there's at least one. This doesn't directly affect which
    // stream is used to actually record something, but it does determine whether HomeKit even attempts to use the camera for HomeKit Secure Video.
    if(![ 15, 24, 30 ].includes(rtspEntries[0].resolution[2])) {

      // Iterate through the list of RTSP entries we're providing to HomeKit and ensure we have at least one that will meet HomeKit's requirements
      // for frame rate.
      for(let i = 0; i < rtspEntries.length; i++) {

        // We're only interested in the first 1080p or 1440p entry.
        if((rtspEntries[i].resolution[0] !== 1920) || ![ 1080, 1440 ].includes(rtspEntries[i].resolution[1])) {

          continue;
        }

        // Determine the best frame rate to use that's closest to what HomeKit wants to see.
        if(rtspEntries[i].resolution[2] > 24) {

          rtspEntries[i].resolution[2] = 30;
        } else if(rtspEntries[i].resolution[2] > 15) {

          rtspEntries[i].resolution[2] = 24;
        } else {

          rtspEntries[i].resolution[2] = 15;
        }

        break;
      }
    }

    // Publish our updated list of supported resolutions and their URLs.
    this.rtspEntries = rtspEntries;

    // If we've already configured the HomeKit video streaming delegate, we're done here.
    if(this.camera.stream) {

      return true;
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.camera.hasFeature('Debug.Video.Startup')) {

      for(const entry of this.rtspEntries) {

        this.camera.log.info('Mapping resolution: %s.', formatResolution(entry.resolution) + ' => ' + entry.name);
      }
    }

    // Check for explicit RTSP profile preferences.
    for(const rtspProfile of [ 'LOW', 'MEDIUM', 'HIGH' ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(this.camera.hasFeature('Video.Stream.Only.' + rtspProfile)) {

        this.camera.hints.streamingDefault = rtspProfile;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(this.camera.hasFeature('Video.HKSV.Record.Only.' + rtspProfile)) {

        this.camera.hints.recordingDefault = rtspProfile;
      }
    }

    // Inform the user if we've set a streaming default.
    if(this.camera.hints.streamingDefault) {

      this.camera.log.info('Video streaming configured to use only: %s.', toCamelCase(this.camera.hints.streamingDefault.toLowerCase()));
    }

    // Inform the user if they've selected the legacy snapshot API.
    if(!this.camera.hints.highResSnapshots) {

      this.camera.log.info('Disabling the use of higher quality snapshots.');
    }

    // Configure the video stream with our resolutions.
    this.camera.stream = new ProtectStreamingDelegate(this.camera, this.rtspEntries.map(x => x.resolution));

    // If the user hasn't overriden our defaults, make sure we account for constrained hardware environments.
    if(!this.camera.hints.recordingDefault) {

      switch(this.camera.platform.codecSupport.hostSystem) {

        case 'raspbian':

          // For constrained CPU environments like Raspberry Pi, we default to recording from the highest quality channel we can, that's at or below
          // 1080p. That provides a reasonable default, while still allowing users who really want to, to be able to specify something else.
          this.camera.hints.recordingDefault =
            (this.findRtsp(1920, 1080, { maxPixels: this.camera.stream.ffmpegOptions.hostSystemMaxPixels })?.channel.name ?? undefined) as string;

          break;

        default:

          // We default to no preference for the default Protect camera channel.
          this.camera.hints.recordingDefault = (this.camera.hints.hardwareTranscoding ? 'High' : undefined) as string;

          break;
      }
    } else {

      // Inform the user if we've set a recording default.
      this.camera.log.info('HomeKit Secure Video event recording configured to use only: %s.',
        toCamelCase(this.camera.hints.recordingDefault.toLowerCase()));
    }

    // Fire up the controller and inform HomeKit about it.
    this.camera.accessory.configureController(this.camera.stream.controller);

    return true;
  }

  // Find an RTSP configuration for a given target resolution.
  private findRtspEntry(width: number, height: number, options?: RtspOptions): Nullable<RtspEntry> {

    const rtspEntries = options?.rtspEntries ?? this.rtspEntries;

    // No RTSP entries to choose from, we're done.
    if(!rtspEntries.length) {

      return null;
    }

    // Second, we check to see if we've set an explicit preference for stream quality.
    if(options?.default) {

      options.default = options.default.toUpperCase();

      return rtspEntries.find(x => x.channel.name.toUpperCase() === options.default) ?? null;
    }

    // See if we have a match for our desired resolution on the camera. We ignore FPS - HomeKit clients seem to be able to handle it just fine.
    const exactRtsp = rtspEntries.find(x => (x.channel.width === width) && (x.channel.height === height));

    if(exactRtsp) {

      return exactRtsp;
    }

    // If we haven't found an exact match, by default, we bias ourselves to the next lower resolution we find or the lowest resolution we have
    // available as a backstop.
    if(!options?.biasHigher) {

      return rtspEntries.find(x => x.channel.width < width) ?? rtspEntries[rtspEntries.length - 1];
    }

    // If we're biasing ourselves toward higher resolutions (primarily used when transcoding so we start with a higher quality input), we look for the
    // first entry that's larger than our requested width and if not found, we return the highest resolution we have available.
    return rtspEntries.filter(x => x.channel.width > width).pop() ?? rtspEntries[0];
  }

  // Find a streaming RTSP configuration for a given target resolution.
  public findRtsp(width: number, height: number, options?: RtspOptions): Nullable<RtspEntry> {

    // Create our options JSON if needed.
    options ??= {};

    // Set our default stream, if we've configured one.
    options.default = this.camera.hints.streamingDefault;

    // See if we've been given RTSP entries or whether we should default to our own.
    options.rtspEntries ??= this.rtspEntries;

    // If we've imposed a constraint on the maximum dimensions of what we want due to a hardware limitation, filter out those entries.
    if(options.maxPixels !== undefined) {

      options.rtspEntries = options.rtspEntries.filter(x => (x.channel.width * x.channel.height) <= (options.maxPixels ?? Infinity));
    }

    return this.findRtspEntry(width, height, options);
  }

  // Find a recording RTSP configuration for a given target resolution.
  public findRecordingRtsp(width: number, height: number): Nullable<RtspEntry> {

    return this.findRtspEntry(width, height, { biasHigher: true, default: this.camera.hints.recordingDefault });
  }
}
