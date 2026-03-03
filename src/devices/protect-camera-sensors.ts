/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-camera-sensors.ts: Smart detection, tamper, and ambient light sensor delegate for UniFi Protect cameras.
 */
import type { HAP, Service } from 'homebridge';
import { acquireService } from 'homebridge-plugin-utils';
import { PROTECT_AMBIENT_LIGHT_POLL_INTERVAL } from '../settings.js';
import type { ProtectCamera } from './protect-camera.js';
import { ProtectReservedNames } from '../protect-types.js';
import { toCamelCase } from '../protect-utils.js';

export class ProtectCameraSensors {

  private ambientLight: number;
  private ambientLightTimer?: NodeJS.Timeout;
  private readonly camera: ProtectCamera;
  public detectLicensePlate: string[];
  private readonly hap: HAP;
  public isTampered: boolean;

  constructor(camera: ProtectCamera) {

    this.ambientLight = 0;
    this.camera = camera;
    this.detectLicensePlate = [];
    this.hap = camera.api.hap;
    this.isTampered = false;
  }

  // Configure smart detection contact sensors and tamper detection.
  public configure(): boolean {

    this.configureSmartSensors();
    this.configureTamperDetection();

    return true;
  }

  // Configure the ambient light sensor (async, called separately).
  public async configureAmbientLight(): Promise<boolean> {

    // Configure the ambient light sensor only if it exists on the camera.
    if(!this.camera.ufp.featureFlags.hasLuxCheck) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.camera.accessory, this.hap.Service.LightSensor, this.camera.accessoryName, undefined,
      (lightSensorService: Service) => {

        lightSensorService.addOptionalCharacteristic(this.hap.Characteristic.StatusActive);
      });

    // Fail gracefully.
    if(!service) {

      this.camera.log.error('Unable to add ambient light sensor.');

      return false;
    }

    const getLux = async (): Promise<number> => {

      if(!this.camera.isOnline) {

        return -1;
      }

      const response = await this.camera.nvr.ufpApi.retrieve(
        this.camera.nvr.ufpApi.getApiEndpoint(this.camera.ufp.modelKey) + '/' + this.camera.ufp.id + '/lux');

      if(!this.camera.nvr.ufpApi.responseOk(response?.statusCode)) {

        return -1;
      }

      try {

        let lux = (await response?.body.json() as Record<string, number | undefined>).illuminance ?? 0;

        // The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
        lux ||= 0.0001;

        return lux;

      } catch {

        // We're intentionally ignoring any errors parsing a response and will fall through.
      }

      return -1;
    };

    // Update the ambient light sensor at regular intervals
    this.ambientLightTimer = setInterval(async () => {

      // Grab the current ambient light level.
      const lux = await getLux();

      // Nothing to update, we're done.
      if((this.ambientLight === lux) || (lux === -1)) {

        return;
      }

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight = lux);

      // Publish the state.
      this.camera.nvr.mqtt?.publish(this.camera.ufp.mac, 'ambientlight', this.ambientLight.toString());
    }, PROTECT_AMBIENT_LIGHT_POLL_INTERVAL);

    // Retrieve the active state when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.camera.isOnline);

    // Initialize the sensor.
    this.ambientLight = await getLux();

    if(this.ambientLight === -1) {

      this.ambientLight = 0.0001;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(() => this.ambientLight);

    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.camera.isOnline);

    return true;
  }

  // Configure discrete smart motion contact sensors for HomeKit.
  private configureSmartSensors(): boolean {

    // Get any license plates the user has configured for detection, if any.
    this.detectLicensePlate = this.camera.getFeatureValue('Motion.SmartDetect.ObjectSensors.LicensePlate')
      ?.split('-').filter(x => x.length).map(x => x.toUpperCase()) ?? [];

    // Check if we have disabled specific license plate smart motion object contact sensors, and if so, remove them.
    for(const objectService of
      this.camera.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.'))) {

      // Do we have smart motion detection as well as license plate telemetry available to us and is this license plate configured? If so, move on.
      if(this.camera.ufp.featureFlags.hasSmartDetect && this.camera.ufp.featureFlags.smartDetectTypes.includes('licensePlate') &&
        objectService.subtype && this.detectLicensePlate.includes(objectService.subtype.slice(objectService.subtype.indexOf('.') + 1))) {

        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.camera.accessory.removeService(objectService);
      this.camera.log.info('Disabling smart motion license plate contact sensor: %s.',
        objectService.subtype?.slice(objectService.subtype.indexOf('.') + 1));
    }

    // If we don't have smart motion detection available or we have smart motion object contact sensors disabled, let's remove them.
    if(!this.camera.hints.smartDetectSensors) {

      // Check for object-centric contact sensors that are no longer enabled and remove them.
      for(const objectService of
        this.camera.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.'))) {

        // We don't have this contact sensor enabled, remove it.
        this.camera.accessory.removeService(objectService);
        this.camera.log.info('Disabling smart motion contact sensor: %s.', objectService.subtype?.slice(objectService.subtype.indexOf('.') + 1));
      }
    }

    // If we don't have smart motion detection, we're done.
    if(!this.camera.ufp.featureFlags.hasSmartDetect) {

      return false;
    }

    // A utility for us to add contact sensors.
    const addSmartDetectContactSensor = (name: string, serviceId: string, errorMessage: string): boolean => {

      // Acquire the service.
      const service = acquireService(this.camera.accessory, this.hap.Service.ContactSensor, name, serviceId);

      // Fail gracefully.
      if(!service) {

        this.camera.log.error(errorMessage);

        return false;
      }

      // Initialize the sensor.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      return true;
    };

    let enabledContactSensors = [];

    // Add individual contact sensors for each object detection type, if needed.
    if(this.camera.hints.smartDetectSensors) {

      for(const smartDetectType of [ ...this.camera.ufp.featureFlags.smartDetectAudioTypes,
        ...this.camera.ufp.featureFlags.smartDetectTypes ].sort()) {

        if(addSmartDetectContactSensor(this.camera.accessoryName + ' ' + toCamelCase(smartDetectType),
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.' + smartDetectType,
          'Unable to add smart motion contact sensor for ' + smartDetectType + ' detection.')) {

          enabledContactSensors.push(smartDetectType);
        }
      }

      this.camera.log.info('Smart motion contact sensor%s enabled: %s.', enabledContactSensors.length > 1 ? 's' : '',
        enabledContactSensors.join(', '));
    }

    enabledContactSensors = [];

    // Now process license plate contact sensors for individual detections.
    if(this.camera.ufp.featureFlags.smartDetectTypes.includes('licensePlate')) {

      // Get the list of plates.
      for(const licenseOption of this.detectLicensePlate.filter(plate => plate.length)) {

        if(addSmartDetectContactSensor(this.camera.accessoryName + ' License Plate ' + licenseOption,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.' + licenseOption,
          'Unable to add smart motion license plate contact sensor for ' + licenseOption + '.')) {

          enabledContactSensors.push(licenseOption);
        }
      }

      if(enabledContactSensors.length) {

        this.camera.log.info('Smart motion license plate contact sensor%s enabled: %s.',
          enabledContactSensors.length > 1 ? 's' : '', enabledContactSensors.join(', '));
      }
    }

    return true;
  }

  // Configure tampering detection for devices that support it.
  public configureTamperDetection(): boolean {

    const service = this.camera.accessory.getService(this.hap.Service.MotionSensor);
    const characteristic = service?.getCharacteristic(this.hap.Characteristic.StatusTampered);

    if(!this.camera.ufp.featureFlags.hasTamperDetection || !this.camera.ufp.smartDetectSettings.enableTamperDetection) {

      if(characteristic) {

        service?.removeCharacteristic(characteristic);
      }

      this.isTampered = false;

      return false;
    }

    // Retrieve the current tamper status when requested.
    characteristic?.onGet(() => this.isTampered);

    return true;
  }

  // Update sensor states.
  public update(): void {

    this.camera.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.camera.isOnline);
    this.camera.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.isTampered);
    this.camera.accessory.getService(this.hap.Service.LightSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.camera.isOnline);
  }

  // Clean up timers.
  public cleanup(): void {

    clearInterval(this.ambientLightTimer);
  }
}
