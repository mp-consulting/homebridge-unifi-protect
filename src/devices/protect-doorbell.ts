/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-doorbell.ts: Doorbell device class for UniFi Protect.
 */
import type { DeepPartial, ProtectCameraConfig, ProtectEventAdd, ProtectEventPacket } from '../unifi/index.js';
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_AUTHSENSOR_DURATION } from '../settings.js';
import { DoorbellChimes } from './protect-doorbell-chimes.js';
import { DoorbellLcdMessages } from './protect-doorbell-messages.js';
import type { PlatformAccessory } from 'homebridge';
import { ProtectCamera } from './protect-camera.js';
import { ProtectCameraPackage } from './protect-camera-package.js';
import { ProtectReservedNames } from '../protect-types.js';
import { sanitizeName } from '../lib/index.js';

// Doorbell class. Doorbell-specific capabilities are implemented by composition delegates: LCD messages (DoorbellLcdMessages) and physical chimes and chime
// volume (DoorbellChimes). This class wires them into the camera lifecycle and handles the package camera and authentication sensor.
export class ProtectDoorbell extends ProtectCamera {

  // These are declared rather than initialized as class fields. configureDevice() runs from within our parent's constructor, and class field initializers
  // would otherwise reset these to undefined once our parent's constructor returns.
  declare public chimes: DoorbellChimes;
  declare private contactAuthTimer?: NodeJS.Timeout | undefined;
  declare public lcdMessages: DoorbellLcdMessages;

  // Configure the doorbell for HomeKit.
  protected override configureDevice(): boolean {

    // Initialize our delegates.
    this.chimes = new DoorbellChimes(this);
    this.lcdMessages = new DoorbellLcdMessages(this);
    this.packageCamera = null;

    // We only want to deal with actual Protect doorbell devices.
    if(!this.ufp.featureFlags.isDoorbell) {

      return false;
    }

    // Call our parent to setup the camera portion of the doorbell.
    super.configureDevice();

    // Configure our package camera, if we have one.
    this.configurePackageCamera();

    // Let's setup the doorbell-specific attributes.
    this.configureVideoDoorbell();

    // Configure the authentication sensor, if enabled.
    this.configureAuthSensor();

    // Configure the doorbell LCD message capabilities.
    this.lcdMessages.configure();

    // Configure physical chime switches and volume control, if enabled.
    this.chimes.configure();

    // Register our event handlers.
    this.subscribe('updateEvent.' + this.nvr.ufp.id, (packet) => this.lcdMessages.nvrEventHandler(packet));
    this.subscribe('updateEvent.chime', (packet) => this.chimes.chimeEventHandler(packet));

    return true;
  }

  // Cleanup after ourselves if we're being deleted.
  public override cleanup(): void {

    clearTimeout(this.contactAuthTimer);
    this.contactAuthTimer = undefined;

    if(this.packageCamera) {

      this.packageCamera.cleanup();
      this.packageCamera = null;
    }

    super.cleanup();
  }

  // Configure a package camera, if one exists.
  private configurePackageCamera(): boolean {

    // First, confirm the device has a package camera.
    if(!this.ufp.featureFlags.hasPackageCamera) {

      return false;
    }

    // If we've already setup the package camera, we're done.
    if(this.packageCamera) {

      return true;
    }

    // Generate a UUID for the package camera.
    const uuid = this.hap.uuid.generate(this.ufp.mac + '.PackageCamera');

    // Let's find it if we've already created it.
    let packageCameraAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory(sanitizeName(this.accessoryName + ' Package Camera'), uuid);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature('Device.Standalone')) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [packageCameraAccessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [packageCameraAccessory]);
      }

      this.platform.accessories.push(packageCameraAccessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Now create the package camera accessory. We do want to modify the camera name to ensure things look pretty.
    this.packageCamera = new ProtectCameraPackage(this.nvr,
      Object.assign({}, this.ufp, { name: (this.ufp.name ?? this.ufp.marketName) + ' Package Camera' }), packageCameraAccessory);

    return true;
  }

  // Configure the contact sensor to indicate authentication success.
  private configureAuthSensor(): boolean {

    // Validate whether we should have this service enabled.
    // The authentication contact sensor is disabled by default unless the user enables it. We only make it available if we have at least one of the
    // fingerprint sensor or the NFC sensor available.
    if(!this.validService(this.hap.Service.ContactSensor,
      this.hasFeature('Doorbell.AuthSensor') && (this.ufp.enableNfc || this.ufp.featureFlags.hasFingerprintSensor),
      ProtectReservedNames.CONTACT_AUTHSENSOR)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + ' Authenticated', ProtectReservedNames.CONTACT_AUTHSENSOR);

    if(!service) {

      this.log.error('Unable to add authentication sensor.');

      return false;
    }

    // Initialize the authentication contact sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

    this.log.info('Enabling Protect authentication contact sensor.');

    return true;
  }

  // Configure MQTT capabilities for the doorbell.
  protected override configureMqtt(): boolean {

    // Call our parent to setup the general camera MQTT capabilities.
    super.configureMqtt();

    // Configure chime volume and doorbell message MQTT capabilities.
    this.chimes.configureMqtt();
    this.lcdMessages.configureMqtt();

    return true;
  }

  // Refresh doorbell-specific characteristics.
  public override updateDevice(): boolean {

    super.updateDevice();

    // Update the package camera state, if we have one.
    if(this.packageCamera) {

      this.packageCamera.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);
    }

    // Check for updates to the physical chime state.
    this.chimes.update();

    return true;
  }

  // Handle doorbell-related events.
  protected override eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as DeepPartial<ProtectCameraConfig>;

    super.eventHandler(packet);

    // Update the package camera, if we have one.
    if(this.packageCamera) {

      this.packageCamera.ufp = Object.assign({}, this.ufp, { name: (this.ufp.name ?? this.ufp.marketName) + ' Package Camera' });
    }

    // If we have a package camera that has HKSV enabled, we'll trigger it's motion sensor here. Why? HKSV requires a motion sensor attached to
    // that camera accessory, and since a package camera is actually a secondary camera on a device with a single motion sensor, we use that motion
    // sensor to trigger the package camera's HKSV event recording.
    if(payload.lastMotion && this.packageCamera?.stream?.hksv?.isRecording) {

      this.nvr.events.motionEventHandler(this.packageCamera);
    }

    // Process LCD message events.
    if(payload.lcdMessage) {

      this.lcdMessages.update(payload.lcdMessage);
    }
  }

  // Handle add-related events from the controller.
  protected override addEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    super.addEventHandler(packet);

    // Process any authentication events.
    if(payload.type && [ 'fingerprintIdentified', 'nfcCardScanned' ].includes(payload.type)) {

      // Clear out the contact sensor timer.
      if(this.contactAuthTimer) {

        clearTimeout(this.contactAuthTimer);
        this.contactAuthTimer = undefined;
      }

      // Grab the service, if we've configured it.
      const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR);

      // We've failed to authenticate, we're done.
      if(!payload.metadata?.fingerprint?.ulpId && !payload.metadata?.nfc?.ulpId) {

        service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

        return;
      }

      // We've successfully authenticated either a fingerprint or an NFC card.
      service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

      // Publish to MQTT, if the user has configured it.
      const authInfo: Record<string, string> = { type: 'fingerprint' };

      // We publish a bit more information if we have an NFC card.
      if(payload.type === 'nfcCardScanned') {

        authInfo.id = payload.metadata.nfc?.nfcId ?? '';
        authInfo.type = 'nfc';
      }

      this.publish('authenticate', JSON.stringify(authInfo));

      // Reset our contact sensor after our auth sensor duration.
      this.contactAuthTimer = setTimeout(() => {

        service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
        this.contactAuthTimer = undefined;
      }, PROTECT_DOORBELL_AUTHSENSOR_DURATION);
    }
  }
}
