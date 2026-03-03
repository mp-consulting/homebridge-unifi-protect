/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-events.ts: Protect events class for UniFi Protect.
 */
import type { API, HAP, Service } from 'homebridge';
import type { HomebridgePluginLogging, Nullable } from 'homebridge-plugin-utils';
import type { ProtectApi, ProtectEventAdd, ProtectEventMetadata, ProtectEventMetadataDetectedThumbnail, ProtectEventPacket,
  ProtectKnownDeviceTypes } from 'unifi-protect';
import type { ProtectCamera, ProtectDevice } from './devices/index.js';
import { type ProtectDeviceConfigTypes, ProtectReservedNames } from './protect-types.js';
import { EventEmitter } from 'node:events';
import { PROTECT_DOORBELL_TRIGGER_DURATION } from './settings.js';
import type { ProtectNvr } from './protect-nvr.js';
import type { ProtectPlatform } from './protect-platform.js';
import { mergeJson } from './protect-utils.js';

export class ProtectEvents extends EventEmitter {

  private api: API;
  private hap: HAP;
  private log: HomebridgePluginLogging;
  private mqttPublishTelemetry: boolean;
  private nvr: ProtectNvr;
  private readonly eventTimers: Map<string, NodeJS.Timeout | undefined>;
  private ufpApi: ProtectApi;
  private ufpDeviceState: Record<string, ProtectDeviceConfigTypes>;
  private platform: ProtectPlatform;
  private unsupportedDevices: Record<string, boolean>;

  // Initialize an instance of our Protect events handler.
  constructor(nvr: ProtectNvr) {

    super();

    this.api = nvr.platform.api;
    this.eventTimers = new Map();
    this.hap = nvr.platform.api.hap;
    this.log = nvr.log;
    this.mqttPublishTelemetry = nvr.hasFeature('Nvr.Publish.Telemetry');
    this.nvr = nvr;
    this.ufpApi = nvr.ufpApi;
    this.ufpDeviceState = {};
    this.platform = nvr.platform;
    this.unsupportedDevices = {};

    // If we've enabled telemetry from the controller inform the user.
    if(this.mqttPublishTelemetry) {

      this.log.info('Protect controller telemetry enabled.');
    }

    this.configureEvents();
  }

  // Merge Protect JSON update payloads into the Protect configuration JSON for a device while dealing with deep objects.
  private updateUfp<DeviceType extends ProtectKnownDeviceTypes>(ufp: DeviceType, payload: unknown): DeviceType {

    return mergeJson(ufp as unknown as Record<string, unknown>, payload as Record<string, unknown>) as DeviceType;
  }

  // Manage event timers - clears any existing timer for the key, sets a new one, and auto-deletes on expiry.
  private resetTimer(key: string, callback: () => void, duration: number): void {

    clearTimeout(this.eventTimers.get(key));

    this.eventTimers.set(key, setTimeout(() => {

      callback();
      this.eventTimers.delete(key);
    }, duration));
  }

  // Process Protect API update events.
  private ufpUpdates(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectDeviceConfigTypes;
    let protectDevice: Nullable<ProtectDevice>;

    switch(packet.header.modelKey) {

      case 'nvr':

        this.nvr.ufp = this.updateUfp(this.nvr.ufp, payload);

        break;

      default:

        // Lookup the device.
        protectDevice = this.nvr.getDeviceById(packet.header.id);

        // No device found, we're done.
        if(!protectDevice) {

          break;
        }

        // Update our device state. If we're refreshing the bootstrap, we set it as the full payload rather than update the UFP configuration.
        protectDevice.ufp = packet.header.hbupBootstrap ? payload : this.updateUfp(protectDevice.ufp, payload);

        // Detect device availability changes. This ensures we capture the true availability state of a Protect device since it appears that Protect
        // occasionally fails to send an event out indicating state changes. We catch anything that's been missed dynamically when the bootstrap update occurs.
        if('isConnected' in payload) {

          // If we have services on the accessory associated with the Protect device that have a StatusActive characteristic set, update our availability state.
          protectDevice.accessory.services.filter(x => x.testCharacteristic(this.hap.Characteristic.StatusActive))
            .forEach(x => x.updateCharacteristic(this.hap.Characteristic.StatusActive, protectDevice?.isOnline ?? true));
        }

        // If this is a bootstrap-related update, we're done here. Anything beyond this point is intended for dynamic event updates.
        if(packet.header.hbupBootstrap) {

          break;
        }

        // Sync names, if configured to do so.
        if(payload.name && protectDevice.hints.syncName) {

          protectDevice.log.info('Name change detected. A restart of Homebridge may be needed in order to complete name synchronization with HomeKit.');
          protectDevice.configureInfo();
        }

        break;
    }

    // Update the internal list we maintain.
    this.ufpDeviceState[packet.header.id] = Object.assign(this.ufpDeviceState[packet.header.id] ?? {}, payload);
  }

  // Process device additions and removals from the Protect update events API.
  private manageDevices(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    // We only want adoption-related events.
    if((packet.header.modelKey !== 'event') || ((payload.type !== 'deviceAdopted') && (payload.type !== 'deviceUnadopted'))) {

      return;
    }

    // Make sure we have the right information to process the event.
    if(!payload.metadata || !('deviceId' in payload.metadata) || !('text' in (payload.metadata.deviceId as Record<string, unknown>))) {

      return;
    }

    // Lookup the device.
    const deviceId = (payload.metadata.deviceId as Record<string, unknown>).text as string;
    const protectDevice = this.nvr.getDeviceById(deviceId);

    // We're adopting.
    if(payload.type === 'deviceAdopted') {

      if(protectDevice) {

        return;
      }

      this.nvr.addHomeKitDevice(this.ufpDeviceState[deviceId]);

      return;
    }

    // We're unadopting. If it's already gone, we're done.
    if(!protectDevice) {

      return;
    }

    // Remove the device.
    this.nvr.removeHomeKitDevice(protectDevice.accessory);

    return;
  }

  // Listen to the UniFi Protect realtime updates API for updates we are interested in (e.g. motion).
  private configureEvents(): boolean {

    // Ensure we update our UFP state before we process any other events.
    this.prependListener('updateEvent', this.ufpUpdates.bind(this));

    // Process remove events.
    this.prependListener('addEvent', this.manageDevices.bind(this));

    // Listen for any messages coming in from our listener. We route events to the appropriate handlers based on the type of event that comes across.
    this.ufpApi.on('message', (packet: ProtectEventPacket): void => {

      let cameraId;

      switch(packet.header.action) {

        case 'add':

          this.emit('addEvent', packet);

          cameraId = (packet.payload as ProtectEventAdd).camera ?? (packet.payload as ProtectEventAdd).cameraId;

          if(cameraId) {

            this.emit('addEvent.' + cameraId, packet);
          }

          this.emit('addEvent.' + packet.header.modelKey, packet);

          break;

        case 'remove':

          this.emit('removeEvent', packet);
          this.emit('removeEvent.' + packet.header.id, packet);
          this.emit('removeEvent.' + packet.header.modelKey, packet);

          break;

        case 'update':

          this.emit('updateEvent', packet);
          this.emit('updateEvent.' + packet.header.id, packet);
          this.emit('updateEvent.' + packet.header.modelKey, packet);

          if('recordId' in packet.header) {

            this.emit('updateEvent.' + packet.header.recordId, packet);
          }

          break;

        default:

          break;
      }

      // If enabled, publish all the event traffic coming from the Protect controller to MQTT.
      if(this.mqttPublishTelemetry) {

        this.nvr.mqtt?.publish(this.nvr.ufp.mac, 'telemetry', JSON.stringify(packet));
      }
    });

    return true;
  }

  // Motion event processing from UniFi Protect.
  public motionEventHandler(protectDevice: ProtectDevice, detectedObjects: string[] = [], metadata?: ProtectEventMetadata): void {

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = protectDevice.accessory.getService(this.hap.Service.MotionSensor);

    if(motionService) {

      this.motionEventDelivery(protectDevice, motionService, detectedObjects, metadata);
    }
  }

  // Motion event delivery to HomeKit.
  private motionEventDelivery(protectDevice: ProtectDevice, motionService: Service, detectedObjects: string[], metadata: ProtectEventMetadata = {}): void {

    // If we have disabled motion events, we're done here.
    if(protectDevice.accessory.context.detectMotion === false) {

      return;
    }

    // Handle core motion detection trigger and reset timer.
    this.handleMotionEvent(protectDevice, motionService);

    // We build a unified list of the object events we're interested in: legacy smart detections first, followed by thumbnail-based detections.
    type EventItem = {

      type: string;
      name?: string;
      confidence?: number;
      payload?: ProtectEventMetadataDetectedThumbnail;
    };

    const smartEvents: EventItem[] = [];

    // Only look for smart detections if we're configured to do so.
    if(protectDevice.hints.smartDetect) {

      // Add our legacy smart detections.
      smartEvents.push(...detectedObjects.map(type => ({ type })));

      // Now add our thumbnail-based detections.
      if(metadata.detectedThumbnails) {

        smartEvents.push(...metadata.detectedThumbnails.filter(thumbnail => thumbnail.type).map(detection => ({

          confidence: detection.confidence,
          name: detection.name,
          payload: detection as ProtectEventMetadataDetectedThumbnail,
          type: detection.type as string,
        })));
      }
    }

    // Handle smart detection sensors and vehicle-specific (including license plate) processing.
    this.handleSmartDetection(protectDevice, smartEvents);

    // Handle occupancy sensor trigger and reset timer.
    this.handleOccupancy(protectDevice, detectedObjects);
  }

  // Core motion detection trigger and reset timer.
  private handleMotionEvent(protectDevice: ProtectDevice, motionService: Service): void {

    // Only update HomeKit if we don't have a motion event inflight.
    if(!this.eventTimers.has(protectDevice.id)) {

      // Trigger the motion event in HomeKit.
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

      // If we have a motion trigger switch configured, update it.
      protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER)
        ?.updateCharacteristic(this.hap.Characteristic.On, true);

      // Publish the motion event to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'motion', 'true');

      // Log the event, if configured to do so.
      if(protectDevice.hints.logMotion) {

        protectDevice.log.info('Motion detected.');
      }
    }

    // Reset our motion event after motionDuration.
    this.resetTimer(protectDevice.id, () => {

      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // If we have a motion trigger switch configured, update it.
      protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER)
        ?.updateCharacteristic(this.hap.Characteristic.On, false);

      protectDevice.log.debug('Resetting motion event.');

      // Publish to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'motion', 'false');
    }, protectDevice.hints.motionDuration * 1000);
  }

  // Smart object detection sensors and MQTT publishing.
  private handleSmartDetection(protectDevice: ProtectDevice, smartEvents: { type: string; name?: string; confidence?: number;
    payload?: ProtectEventMetadataDetectedThumbnail }[]): void {

    // Iterate over the smart events that Protect has detected.
    for(const event of smartEvents) {

      const key = protectDevice.id + '.Motion.SmartDetect.ObjectSensors.' + event.type;

      // We have a new event, let's make sure we trigger our sensors only once.
      if(!this.eventTimers.has(key)) {

        // These sensors only get triggered if they actually exist on the accessory.
        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.' + event.type)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        // Publish the smart detection event to MQTT, if the user has configured it.
        this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'motion/smart/' + event.type, 'true');

        // Inform the user. We handle logging for vehicle-related events below.
        if(protectDevice.hints.logMotion && (event.type !== 'vehicle')) {

          protectDevice.log.info('Smart motion detected: %s.', event.type);
        }
      }

      // Reset our smart detection contact sensors after motionDuration.
      this.resetTimer(key, () => {

        // Reset our smart detection contact sensor.
        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.' + event.type)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

        // Publish the smart detection event to MQTT, if the user has configured it.
        this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'motion/smart/' + event.type, 'false');
        protectDevice.log.debug('Resetting smart object motion event.');
      }, protectDevice.hints.motionDuration * 1000);

      // Vehicles have additional attributes that can be associated with their smart detections. We process those here.
      if(event.type === 'vehicle') {

        this.handleLicensePlate(protectDevice, event, key);
      }
    }
  }

  // License plate specific handling (subset of vehicle smart detection).
  private handleLicensePlate(protectDevice: ProtectDevice, event: { type: string; name?: string; confidence?: number;
    payload?: ProtectEventMetadataDetectedThumbnail }, key: string): void {

    // We have a license plate. Let's see if we have a match with what the user has configured.
    if(event.name) {

      const plate = event.name.toUpperCase();
      const plateKey = key + '.' + plate;

      // We have a new plate detection.
      if(!this.eventTimers.has(plateKey)) {

        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.' + plate)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
      }

      // Reset our license plate smart detection contact sensor after motionDuration.
      this.resetTimer(plateKey, () => {

        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.' + plate)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
      }, protectDevice.hints.motionDuration * 1000);
    }

    // Publish event metadata when we see it. Currently, Protect publishes additional telemetry for vehicle types.
    if(protectDevice.hints.logMotion) {

      const attributes: string[] = [];

      // We have a license plate.
      if(event.name) {

        attributes.push('license plate: ' + event.name + ' [' + event.confidence + '% confidence]');
      }

      // Look at the color and vehicle type.
      for(const attribute of [ 'color', 'vehicleType' ] as const) {

        if(event.payload?.attributes?.[attribute]) {

          attributes.push(attribute + ': ' + event.payload.attributes[attribute].val +
            ' [' + event.payload.attributes[attribute].confidence + '% confidence]');
        }
      }

      // Inform the user.
      if(attributes.length) {

        this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'motion/smart/' + event.type + '/metadata', JSON.stringify({

          ...(Number.isFinite(event.confidence) && { confidence: event.confidence }),
          ...(event.name?.length && { name: event.name }),
          type: event.type,
          ...(event.payload?.attributes?.color && { color: event.payload.attributes.color }),
          ...(event.payload?.attributes?.vehicleType && { vehicleType: event.payload.attributes.vehicleType }),
        }));
      }

      protectDevice.log.info('Smart motion detected: %s%s.', event.type, attributes.length ? (' (' + attributes.join(', ') + ')') : '');
    }
  }

  // Occupancy sensor trigger and reset timer.
  private handleOccupancy(protectDevice: ProtectDevice, detectedObjects: string[]): void {

    // If we don't have smart detection enabled, or if we do have it enabled and we have a smart detection event that's detected something of interest,
    // let's process our occupancy event updates.
    if(!protectDevice.hints.smartDetect || detectedObjects.some(x => protectDevice.hints.smartOccupancy.includes(x))) {

      // First, let's determine if the user has an occupancy sensor configured, before we process anything.
      const occupancyService = protectDevice.accessory.getService(this.hap.Service.OccupancySensor);

      if(occupancyService) {

        const occupancyKey = protectDevice.id + '.Motion.OccupancySensor';

        // If the occupancy sensor isn't already triggered, let's do so now.
        if(occupancyService.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value !== true) {

          // Trigger the occupancy event in HomeKit.
          occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, true);

          // Publish the occupancy event to MQTT, if the user has configured it.
          this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'occupancy', 'true');

          // Log the event, if configured to do so.
          if(protectDevice.hints.logMotion) {

            protectDevice.log.info('Occupancy detected%s.',
              protectDevice.hints.smartDetect ? ': ' + protectDevice.hints.smartOccupancy.filter(x => detectedObjects.includes(x)).join(', ') : '');
          }
        }

        // Reset our occupancy state after occupancyDuration.
        this.resetTimer(occupancyKey, () => {

          // Reset the occupancy sensor.
          occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);

          // Publish to MQTT, if the user has configured it.
          this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'occupancy', 'false');

          // Log the event, if configured to do so.
          if(protectDevice.hints.logMotion) {

            protectDevice.log.info('Occupancy no longer detected.');
          }
        }, protectDevice.hints.occupancyDuration * 1000);
      }
    }
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  public doorbellEventHandler(protectDevice: ProtectCamera, lastRing: Nullable<number>): void {

    if(!lastRing) {

      return;
    }

    // If we have an inflight ring event, and we're enforcing a ring duration, we're done.
    if(this.eventTimers.has(protectDevice.id + '.Doorbell.Ring')) {

      return;
    }

    // Only notify the user if we have a doorbell.
    const doorbellService = protectDevice.accessory.getService(this.hap.Service.Doorbell);

    if(!doorbellService) {

      return;
    }

    // Trigger the doorbell event in HomeKit, if we're configured to do so.
    if(!protectDevice.accessory.context.doorbellMuted) {

      doorbellService.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
        .sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }

    // Check to see if we have a doorbell trigger switch configured. If we do, update it.
    const triggerService = protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    if(triggerService) {

      // Flag that we're ringing.
      protectDevice.isRinging = true;

      // Update the trigger switch state.
      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);

      // Reset our doorbell trigger.
      this.resetTimer(protectDevice.id + '.Doorbell.Ring.Trigger', () => {

        protectDevice.isRinging = false;

        triggerService.updateCharacteristic(this.hap.Characteristic.On, false);
        this.log.debug('Resetting doorbell ring trigger.');
      }, PROTECT_DOORBELL_TRIGGER_DURATION);
    }

    // Publish to MQTT, if the user has configured it.
    this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'doorbell', 'true');

    if(protectDevice.hints.logDoorbell) {

      protectDevice.log.info('Doorbell ring detected.');
    }

    // Fire off our MQTT doorbell ring event reset.
    this.resetTimer(protectDevice.id + '.Doorbell.Ring.MQTT', () => {

      this.nvr.mqtt?.publish(protectDevice.ufp.mac, 'doorbell', 'false');
    }, PROTECT_DOORBELL_TRIGGER_DURATION);

    // If we don't have a ring duration defined, we're done.
    if(!this.nvr.platform.config.ringDelay) {

      return;
    }

    // Reset our ring threshold.
    this.resetTimer(protectDevice.id + '.Doorbell.Ring', () => {}, this.nvr.platform.config.ringDelay * 1000);
  }
}
