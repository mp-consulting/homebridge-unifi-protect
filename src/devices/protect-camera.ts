/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory, Resolution } from 'homebridge';
import type { DeepPartial, ProtectCameraChannelConfig, ProtectCameraConfig, ProtectEventAdd, ProtectEventPacket } from 'unifi-protect';
import { ProtectReservedNames } from '../protect-types.js';
import { LivestreamManager } from '../protect-livestream.js';
import type { MessageSwitchInterface } from './protect-doorbell.js';
import type { Nullable } from 'homebridge-plugin-utils';
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_FFMPEG_PROBESIZE, PROTECT_HOMEKIT_UPDATE_DELAY, PROTECT_TRANSCODE_BITRATE,
  PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE } from '../settings.js';
import { ProtectCameraControls } from './protect-camera-controls.js';
import type { ProtectCameraPackage } from './protect-camera-package.js';
import { ProtectCameraSensors } from './protect-camera-sensors.js';
import { ProtectCameraVideo } from './protect-camera-video.js';
import { ProtectDevice } from './protect-device.js';
import type { ProtectNvr } from '../protect-nvr.js';
import type { ProtectStreamingDelegate } from '../protect-stream.js';

export interface RtspEntry {

  channel: ProtectCameraChannelConfig;
  lens?: number;
  name: string;
  resolution: Resolution;
  url: string;
}

// Format a resolution tuple as a human-readable string.
export function formatResolution(resolution: Resolution): string {

  return resolution[0].toString() + 'x' + resolution[1].toString() + '@' + resolution[2].toString() + 'fps';
}

// Build an FFmpeg audio filter pipeline for noise reduction.
function buildAudioFilterPipeline(fftNr: number, highpass?: number, lowpass?: number): string[] {

  const afOptions: string[] = [];

  // Clamp the noise reduction value to valid FFmpeg ranges.
  fftNr = Math.max(0.01, Math.min(97, fftNr));

  // Only set the highpass and lowpass filters if explicitly provided.
  if(typeof highpass === 'number') {

    afOptions.push('highpass=p=2:f=' + highpass.toString());
  }

  if(typeof lowpass === 'number') {

    afOptions.push('lowpass=p=2:f=' + lowpass.toString());
  }

  // The afftdn filter options: custom noise profile, noise tracking, and specified noise reduction.
  afOptions.push("asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=" + fftNr.toString());

  return afOptions;
}

export class ProtectCamera extends ProtectDevice {

  private accessUnlockTimer?: NodeJS.Timeout;
  public readonly controls: ProtectCameraControls;
  private isDeleted: boolean;
  public isRinging: boolean;
  public readonly livestream: LivestreamManager;
  public messageSwitches: Record<string, MessageSwitchInterface | undefined>;
  public packageCamera?: Nullable<ProtectCameraPackage>;
  public readonly sensors: ProtectCameraSensors;
  public stream?: ProtectStreamingDelegate;
  public ufp: ProtectCameraConfig;
  public readonly video: ProtectCameraVideo;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectCameraConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.controls = new ProtectCameraControls(this);
    this.isDeleted = false;
    this.isRinging = false;
    this.livestream = new LivestreamManager(this);
    this.messageSwitches = {};
    this.sensors = new ProtectCameraSensors(this);
    this.ufp = device;
    this.video = new ProtectCameraVideo(this);

    this.configureHints();
    this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.tsbStreaming = this.hasFeature('Video.Stream.UseApi');
    this.hints.crop = this.hasFeature('Video.Crop');
    this.hints.hardwareDecoding = true;
    this.hints.hardwareTranscoding = this.hasFeature('Video.Transcode.Hardware');
    this.hints.highResSnapshots = this.hasFeature('Video.HighResSnapshots');
    this.hints.hksvRecordingIndicator = this.hasFeature('Video.HKSV.StatusLedIndicator');
    this.hints.ledStatus = this.ufp.featureFlags.hasLedStatus && this.hasFeature('Device.StatusLed');
    this.hints.logDoorbell = this.hasFeature('Log.Doorbell');
    this.hints.logHksv = this.hasFeature('Log.HKSV');
    this.hints.nightVision = this.ufp.featureFlags.hasInfrared && this.hasFeature('Device.NightVision');
    this.hints.nightVisionDimmer = this.ufp.featureFlags.hasInfrared && this.ufp.featureFlags.hasIcrSensitivity &&
      this.hasFeature('Device.NightVision.Dimmer');
    this.hints.nvrRecordingSwitch = this.hasFeature('Nvr.Recording.Switch');
    this.hints.probesize = PROTECT_FFMPEG_PROBESIZE;
    this.hints.rtspOverride = this.ufp.isThirdPartyCamera ? (this.getFeatureValue('Video.Stream.RtspOverride')?.trim() ?? '') : '';
    this.hints.snapshotUrlOverride = this.ufp.isThirdPartyCamera ? (this.getFeatureValue('Video.Snapshot.UrlOverride')?.trim() ?? '') : '';
    this.hints.smartDetect = this.ufp.featureFlags.hasSmartDetect && this.hasFeature('Motion.SmartDetect');
    this.hints.smartDetectSensors = this.hints.smartDetect && this.hasFeature('Motion.SmartDetect.ObjectSensors');
    this.hints.transcode = this.hasFeature('Video.Transcode');
    this.hints.transcodeBitrate = this.getFeatureNumber('Video.Transcode.Bitrate') ?? PROTECT_TRANSCODE_BITRATE;
    this.hints.transcodeHighLatency = this.hasFeature('Video.Transcode.HighLatency');
    this.hints.transcodeHighLatencyBitrate = this.getFeatureNumber('Video.Transcode.HighLatency.Bitrate') ?? PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE;
    this.hints.statusLedSwitch = this.hasFeature('Device.StatusLed.Switch');
    this.hints.twoWayAudio = this.ufp.featureFlags.hasSpeaker && this.hasFeature('Audio') && this.hasFeature('Audio.TwoWay');
    this.hints.twoWayAudioDirect = this.ufp.featureFlags.hasSpeaker && this.hasFeature('Audio') && this.hasFeature('Audio.TwoWay.Direct');

    return true;
  }

  // Initialize the accessory context with shared state: motion detection, HKSV recording, and NVR association. Returns the previously saved context for
  // subclasses that need to restore additional properties.
  protected initializeContext(): Record<string, unknown> {

    // Save our context for reference before we recreate it.
    const savedContext = this.accessory.context;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.detectMotion = savedContext.detectMotion as boolean | undefined ?? true;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    if(this.hasFeature('Video.HKSV.Recording.Switch')) {

      // Compatibility with older releases. I'll remove this in the future.
      if(savedContext.hksvRecording !== undefined) {

        this.accessory.context.hksvRecordingDisabled = !savedContext.hksvRecording;
      } else {

        this.accessory.context.hksvRecordingDisabled = savedContext.hksvRecordingDisabled as boolean | undefined ?? false;
      }
    }

    return savedContext;
  }

  // Configure a camera accessory for HomeKit.
  protected configureDevice(): boolean {

    const savedContext = this.initializeContext();
    this.accessory.context.mac = this.ufp.mac;

    if(this.hasFeature('Doorbell.Mute')) {

      this.accessory.context.doorbellMuted = savedContext.doorbellMuted as boolean | undefined ?? false;
    }

    // Inform the user that motion detection will suck.
    if(this.ufp.recordingSettings.mode === 'never') {

      this.log.warn("Motion events will not be generated by the Protect controller when the controller's camera recording options are set to \"never\".");
    }

    // Check to see if we have smart motion events enabled on a supported camera.
    if(this.hints.smartDetect) {

      const smartDetectTypes = [ ...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes ];

      // Inform the user of what smart detection object types we're configured for.
      this.log.info('Smart motion detection enabled%s.', smartDetectTypes.length ? ': ' + smartDetectTypes.sort().join(', ') : '');
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor(this.isHksvCapable);

    // Configure smart detection sensors, tamper detection, and occupancy.
    this.sensors.configure();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure cropping.
    this.configureCrop();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // We use an IIFE here since we can't make the enclosing function asynchronous.
    void (async (): Promise<void> => {

      // Configure the ambient light sensor.
      await this.sensors.configureAmbientLight();

      // Configure our video stream.
      await this.video.configure();

      // Configure camera controls (details, NVR recording, night vision, access).
      this.controls.configure();

      // Configure the status indicator light switch.
      this.configureStatusLedSwitch();

      // Configure the doorbell mute switch.
      this.configureDoorbellMuteSwitch();

      // Configure the doorbell trigger.
      this.configureDoorbellTrigger();

      // Listen for events.
      this.nvr.events.on('addEvent.' + this.ufp.id, this.listeners['addEvent.' + this.ufp.id] = this.addEventHandler.bind(this));
      this.nvr.events.on('updateEvent.' + this.ufp.id, this.listeners['updateEvent.' + this.ufp.id] = this.eventHandler.bind(this));
    })().catch((error: unknown) => this.log.error('Error configuring camera: %s.', error));

    return true;
  }

  // Cleanup after ourselves if we're being deleted.
  public cleanup(): void {

    // Clean up delegates.
    this.sensors.cleanup();
    clearTimeout(this.accessUnlockTimer);

    // If we've got HomeKit Secure Video enabled and recording, disable it.
    if(this.stream?.hksv?.isRecording) {

      void this.stream.hksv.updateRecordingActive(false);
    }

    // Cleanup our livestream manager.
    this.livestream.shutdown();

    // Unregister our controller.
    if(this.stream) {

      this.accessory.removeController(this.stream.controller);
    }

    super.cleanup();

    this.isDeleted = true;
  }

  // Handle update-related events from the controller.
  protected eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as DeepPartial<ProtectCameraConfig>;
    const hasProperty = (properties: string | string[]): boolean => (Array.isArray(properties) ? properties : [properties]).some(p => p in payload);

    // Process any RTSP stream or video codec updates.
    if(hasProperty([ 'channels', 'videoCodec' ])) {

      void this.video.configure();
    }

    // Process motion events.
    if(hasProperty(['lastMotion'])) {

      // We only want to process the motion event if we have either:
      //
      //  - HKSV recording enabled.
      //  - No enabled smart motion detection capabilities on the Protect device.
      //  - Smart detection disabled.
      if(this.stream?.hksv?.isRecording ||
        !(this.ufp.featureFlags.smartDetectAudioTypes.length || this.ufp.featureFlags.smartDetectTypes.length) || !this.hints.smartDetect) {

        this.nvr.events.motionEventHandler(this);
      }
    }

    // Process ring events.
    if(hasProperty(['lastRing'])) {

      this.nvr.events.doorbellEventHandler(this, payload.lastRing as number);
    }

    // Process smart detection events.
    if(this.hints.smartDetect) {

      const event = payload as unknown as ProtectEventAdd;

      // Filter out any events tagged as "motion". When users enable the "Create motion events" setting on a camera, Protect will create
      // motion-specific thumbnail events. We're only interested in true smart detection events.
      if(event.metadata?.detectedThumbnails) {

        event.metadata.detectedThumbnails = event.metadata.detectedThumbnails.filter(({ type }) => type !== 'motion');
      }

      // Process smart detection events that have occurred on a non-realtime basis. Generally, this includes audio and video events that require more
      // analysis by Protect.
      if(event.smartDetectTypes?.length || event.metadata?.detectedThumbnails?.length) {

        this.nvr.events.motionEventHandler(this, event.smartDetectTypes, event.metadata);
      }
    }

    // Process updates to the tamper detection setting.
    if(hasProperty('smartDetectSettings')) {

      this.sensors.configureTamperDetection();
    }

    // Process camera details updates:
    //
    //   - availability state.
    //   - name change.
    //   - camera night vision.
    //   - camera status light.
    //   - camera recording settings.
    if(hasProperty([ 'isConnected', 'ispSettings', 'name', 'ledSettings', 'recordingSettings' ])) {

      this.updateDevice();
    }
  }

  // Handle add-related events from the controller.
  protected addEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    // Detect UniFi Access unlock events surfaced in Protect.
    if((packet.header.modelKey === 'event') && (payload.metadata?.action === 'open_door') && payload.metadata.openSuccess) {

      const lockService = this.accessory.getServiceById(this.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);

      if(!lockService) {

        return;
      }

      lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
      lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
      this.log.info('Unlocked.');

      if(this.accessUnlockTimer) {

        clearTimeout(this.accessUnlockTimer);
      }

      this.accessUnlockTimer = setTimeout(() => {

        lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
        lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

        this.accessUnlockTimer = undefined;
      }, 2000);

      return;
    }

    // If we've been tampered, flag it accordingly.
    if(!this.sensors.isTampered && (payload.type === 'smartDetectTamper')) {

      this.sensors.isTampered = true;
      this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.sensors.isTampered);

      this.log.info('Tamper event detected. To clear the indicator, toggle tamper detection in the Protect web UI or restart HBUP.');
    }

    // We're only interested in smart motion detection events here. Our rules are:
    //
    //   - We have a smartDetectObject identified.
    //   - We have an event that involves crossing lines or a smart detection zone with specific smart detection types.
    //   - We explicitly filter out events tagged as "motion". When users enable the "Create motion events" setting on a camera, Protect will create
    //     motion-specific
    //     thumbnail events. We're only interested in true smart detection events.
    if(!this.hints.smartDetect || !((packet.header.modelKey === 'smartDetectObject') || ((packet.header.modelKey === 'event') &&
      [ 'smartDetectLine', 'smartDetectZone' ].includes(payload.type) && (payload.type !== 'motion') && payload.smartDetectTypes?.length))) {

      return;
    }

    // Process the motion event.
    this.nvr.events.motionEventHandler(this, (packet.header.modelKey === 'smartDetectObject') ? [payload.type] : payload.smartDetectTypes, payload.metadata);
  }

  // Configure a switch to mute doorbell ring events in HomeKit.
  private configureDoorbellMuteSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature('Doorbell.Mute'), ProtectReservedNames.SWITCH_DOORBELL_MUTE) ||
      !this.accessory.getService(this.hap.Service.Doorbell)) {

      delete this.accessory.context.doorbellMuted;

      return false;
    }

    // Add the switch to the camera, if needed.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + ' Doorbell Mute', ProtectReservedNames.SWITCH_DOORBELL_MUTE);

    // Fail gracefully.
    if(!service) {

      this.log.error('Unable to add the doorbell mute switch.');

      return false;
    }

    // Configure the switch.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.accessory.context.doorbellMuted as boolean);

    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      this.accessory.context.doorbellMuted = !!value;

      this.log.info('Doorbell chime %s.', value ? 'disabled' : 'enabled');
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.doorbellMuted as boolean);

    this.log.info('Enabling doorbell mute switch.');

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // See if we have a doorbell service configured.
    const doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature('Doorbell.Trigger'), ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera isn't actually doorbell-capable hardware.
      if(!this.ufp.featureFlags.isDoorbell && doorbellService) {

        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // We don't have a doorbell service configured, but since we've enabled a doorbell switch, we create the doorbell for automation purposes.
    if(!doorbellService) {

      // Configure the doorbell service.
      if(!this.configureVideoDoorbell()) {

        return false;
      }

      // Now find the doorbell service.
      if(!this.accessory.getService(this.hap.Service.Doorbell)) {

        this.log.error('Unable to find the doorbell service.');

        return false;
      }
    }

    // Add the switch to the camera, if needed.
    const triggerService = this.acquireService(this.hap.Service.Switch, this.accessoryName + ' Doorbell Trigger', ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    // Fail gracefully.
    if(!triggerService) {

      this.log.error('Unable to add the doorbell trigger.');

      return false;
    }

    // Trigger the doorbell.
    triggerService.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.isRinging);

    triggerService.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(value) {

        // Trigger the ring event.
        this.nvr.events.doorbellEventHandler(this, Date.now());
        this.log.info('Doorbell ring event triggered.');

      } else {

        // If the doorbell ring event is still going, we should be as well.
        if(this.isRinging) {

          setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, true), PROTECT_HOMEKIT_UPDATE_DELAY);
        }
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info('Enabling doorbell automation trigger.');

    return true;
  }

  // Configure the doorbell service for HomeKit.
  protected configureVideoDoorbell(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Doorbell);

    // Fail gracefully.
    if(!service) {

      this.log.error('Unable to add doorbell.');

      return false;
    }

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be marked as the primary service on the accessory.
    service.setPrimaryService(true);

    return true;
  }

  // Configure cropping characteristics.
  private configureCrop(): boolean {

    // We haven't enabled cropping.
    if(!this.hints.crop) {

      return true;
    }

    // Set our cropping parameters, clamping to valid ranges.
    const clampCrop = (value: number, fallback: number): number => ((value < 0) || (value > 100)) ? fallback : value;

    this.hints.cropOptions = {

      height: clampCrop(this.getFeatureNumber('Video.Crop.Height') ?? 100, 100),
      width: clampCrop(this.getFeatureNumber('Video.Crop.Width') ?? 100, 100),
      x: clampCrop(this.getFeatureNumber('Video.Crop.X') ?? 0, 0),
      y: clampCrop(this.getFeatureNumber('Video.Crop.Y') ?? 0, 0),
    };

    // Inform the user.
    this.log.info('Cropping the video stream to %sx%s% starting at %sx%s%.',
      this.hints.cropOptions.width, this.hints.cropOptions.height, this.hints.cropOptions.x, this.hints.cropOptions.y);

    // Transform our percentages into decimal form for FFmpeg.
    this.hints.cropOptions.height /= 100;
    this.hints.cropOptions.width /= 100;
    this.hints.cropOptions.x /= 100;
    this.hints.cropOptions.y /= 100;

    return true;
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

    // If we've enabled RTSP-based HKSV recording, warn that this is unsupported.
    if(this.hasFeature('Debug.Video.HKSV.UseRtsp')) {

      this.log.warn('Enabling RTSP-based HKSV events are for debugging purposes only and unsupported.' +
        ' It consumes more resources on both the Protect controller and the system running HBUP.');
    }

    // If we have smart motion events enabled, let's warn the user that things will not work quite the way they expect.
    if(this.isHksvCapable && this.hints.smartDetect) {

      this.log.warn('WARNING: Smart motion detection and HomeKit Secure Video provide overlapping functionality. ' +
        'Only HomeKit Secure Video, when event recording is enabled in the Home app, will be used to trigger motion event notifications for this camera.' +
        (this.hints.smartDetectSensors ? ' Smart motion contact sensors will continue to function using telemetry from UniFi Protect.' : ''));
    }

    return true;
  }

  // Configure a switch to manually enable or disable HKSV recording for a camera.
  private configureHksvRecordingSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature('Video.HKSV.Recording.Switch'), ProtectReservedNames.SWITCH_HKSV_RECORDING)) {

      // Remove our stateful context since it's unneeded.
      delete this.accessory.context.hksvRecordingDisabled;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + ' HKSV Recording', ProtectReservedNames.SWITCH_HKSV_RECORDING);

    // Fail gracefully.
    if(!service) {

      this.log.error('Unable to add HKSV recording switch.');

      return false;
    }

    // Activate or deactivate HKSV recording.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => !this.accessory.context.hksvRecordingDisabled);

    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.accessory.context.hksvRecordingDisabled !== !value) {

        this.log.info('HKSV event recording %s.', value ? 'enabled' : 'disabled');
      }

      this.accessory.context.hksvRecordingDisabled = !value;
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, !(this.accessory.context.hksvRecordingDisabled as boolean));

    this.log.info('Enabling HKSV recording switch.');

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {

    // Return the RTSP URLs when requested.
    this.subscribeGet('rtsp', 'RTSP information', (): string => {

      // Grab all the available RTSP channels and return them as a JSON.
      return JSON.stringify(Object.assign({}, ...this.ufp.channels.filter(channel => channel.isRtspEnabled)
        .map(channel => ({ [channel.name]: 'rtsps://' + (this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host) + ':' +
          this.nvr.ufp.ports.rtsp + '/' + channel.rtspAlias + '?enableSrtp' }))));
    });

    // Trigger snapshots when requested.
    this.subscribeSet('snapshot', 'snapshot trigger', (value: string) => {

      // When we get the right message, we trigger the snapshot request.
      if(value !== 'true') {

        return;
      }

      void this.stream?.handleSnapshotRequest();
    });

    // Enable doorbell-specific MQTT capabilities only when we have a Protect doorbell or a doorbell trigger enabled.
    if(this.ufp.featureFlags.isDoorbell || this.hasFeature('Doorbell.Trigger')) {

      // Trigger doorbell when requested.
      this.subscribeSet('doorbell', 'doorbell ring trigger', (value: string) => {

        // When we get the right message, we trigger the doorbell request.
        if(value !== 'true') {

          return;
        }

        this.nvr.events.doorbellEventHandler(this, Date.now());
      });
    }

    return true;
  }

  // Refresh camera-specific characteristics.
  public updateDevice(): boolean {

    this.sensors.update();
    this.controls.update();

    return true;
  }

  // Find a streaming RTSP configuration for a given target resolution.
  public findRtsp(...args: Parameters<ProtectCameraVideo['findRtsp']>): Nullable<RtspEntry> {

    return this.video.findRtsp(...args);
  }

  // Find a recording RTSP configuration for a given target resolution.
  public findRecordingRtsp(...args: Parameters<ProtectCameraVideo['findRecordingRtsp']>): Nullable<RtspEntry> {

    return this.video.findRecordingRtsp(...args);
  }

  // License plates configured for smart detection.
  public get detectLicensePlate(): string[] {

    return this.sensors.detectLicensePlate;
  }

  // Utility property to return whether the camera is HKSV capable or not.
  public get isHksvCapable(): boolean {

    return (!this.ufp.isThirdPartyCamera && !this.ufp.isAdoptedByAccessApp) || (this.ufp.isThirdPartyCamera && this.ufp.isPairedWithAiPort);
  }

  // Utility to return our audio filter pipeline for this camera.
  public get audioFilters(): string[] {

    if(!this.hasFeature('Audio.Filter.Noise')) {

      return [];
    }

    return buildAudioFilterPipeline(
      this.getFeatureFloat('Audio.Filter.Noise.FftNr') ?? PROTECT_FFMPEG_AUDIO_FILTER_FFTNR,
      this.getFeatureNumber('Audio.Filter.Noise.HighPass') ?? undefined,
      this.getFeatureNumber('Audio.Filter.Noise.LowPass') ?? undefined,
    );
  }
}
