/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-camera-controls.ts: Night vision, NVR recording, access lock, and camera details delegate for UniFi Protect cameras.
 */
import type { CharacteristicValue, HAP } from 'homebridge';
import { acquireService, validService } from 'homebridge-plugin-utils';
import { PROTECT_HOMEKIT_UPDATE_DELAY } from '../settings.js';
import type { ProtectCamera } from './protect-camera.js';
import type { ProtectCameraConfig } from 'unifi-protect';
import { ProtectReservedNames } from '../protect-types.js';
import { toCamelCase } from '../protect-utils.js';

// Night vision mode-to-brightness mapping. The custom/customFilterOnly range (20-90) is interpolated via icrCustomValue.
const NIGHT_VISION_MAP: ReadonlyMap<string, number> = new Map([

  [ 'off', 0 ],
  [ 'autoFilterOnly', 5 ],
  [ 'auto', 10 ],
  [ 'on', 100 ],
]);

const NIGHT_VISION_BRIGHTNESS_MAP: ReadonlyMap<number, string> = new Map([

  [ 0, 'off' ],
  [ 5, 'autoFilterOnly' ],
  [ 10, 'auto' ],
  [ 100, 'on' ],
]);

const UFP_RECORDING_SWITCHES = [

  ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS,
  ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS,
  ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER,
] as const;

export class ProtectCameraControls {

  private readonly camera: ProtectCamera;
  private readonly hap: HAP;

  constructor(camera: ProtectCamera) {

    this.camera = camera;
    this.hap = camera.api.hap;
  }

  // Configure all camera controls.
  public configure(): void {

    this.configureCameraDetails();
    this.configureNvrRecordingSwitch();
    this.configureNightVisionDimmer();
    this.configureAccessFeatures();
  }

  // Update control states.
  public update(): void {

    // Check to see if this device has a status light.
    if(this.camera.hints.ledStatus) {

      this.camera.accessory.getService(this.hap.Service.CameraOperatingMode)
        ?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.camera.statusLed);
    }

    // Check to see if this device has night vision.
    if(this.camera.hints.nightVision) {

      this.camera.accessory.getService(this.hap.Service.CameraOperatingMode)
        ?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    if(this.camera.hints.nightVisionDimmer) {

      this.camera.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.On, this.nightVision);

      this.camera.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);
    }

    // Update the status indicator light switch.
    if(this.camera.hints.statusLedSwitch) {

      this.camera.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.
        updateCharacteristic(this.hap.Characteristic.On, this.camera.statusLed);
    }

    // Check for updates to the recording state, if we have the switches configured.
    if(this.camera.hints.nvrRecordingSwitch) {

      // Update all the switch states.
      for(const ufpRecordingSwitchType of UFP_RECORDING_SWITCHES) {

        const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf('.') + 1);

        // Update state based on the recording mode.
        this.camera.accessory.getServiceById(this.hap.Service.Switch, ufpRecordingSwitchType)?.
          updateCharacteristic(this.hap.Characteristic.On, ufpRecordingSetting === this.camera.ufp.recordingSettings.mode);
      }
    }
  }

  // Configure additional camera-specific characteristics for HomeKit.
  private configureCameraDetails(): boolean {

    // Find the service, if it exists.
    const service = this.camera.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Retrieve the camera status light if we have it enabled.
    const statusLight = service?.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator);

    if(!this.camera.isHksvCapable || !this.camera.hints.ledStatus) {

      if(statusLight) {

        service?.removeCharacteristic(statusLight);
      }
    } else {

      // Turn the status light on or off.
      statusLight?.onGet(() => this.camera.statusLed);
      statusLight?.onSet(async (value: CharacteristicValue) => this.camera.setStatusLed(!!value));

      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.camera.statusLed);
    }

    // Retrieve the night vision indicator if we have it enabled.
    const nightVisionCharacteristic = service?.getCharacteristic(this.hap.Characteristic.NightVision);

    if(!this.camera.isHksvCapable || !this.camera.hints.nightVision) {

      if(nightVisionCharacteristic) {

        service?.removeCharacteristic(nightVisionCharacteristic);
      }
    } else {

      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onGet(() => this.nightVision);
      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onSet(async (value: CharacteristicValue) => {

        // Update the night vision setting in Protect.
        const newUfp = await this.camera.nvr.ufpApi.updateDevice(this.camera.ufp, { ispSettings: { irLedMode: value ? 'auto' : 'off' } });

        if(!newUfp) {

          this.camera.log.error('Unable to set night vision to %s. Please ensure this username has the Administrator role in UniFi Protect.',
            value ? 'auto' : 'off');

          setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.NightVision, !value), PROTECT_HOMEKIT_UPDATE_DELAY);

          return;
        }

        // Update our internal view of the device configuration.
        this.camera.ufp = newUfp;
      });

      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    return true;
  }

  // Configure the night vision dimmer.
  private configureNightVisionDimmer(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.camera.accessory, this.hap.Service.Lightbulb, this.camera.hints.nightVisionDimmer,
      ProtectReservedNames.LIGHTBULB_NIGHTVISION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.camera.accessory, this.hap.Service.Lightbulb, this.camera.accessoryName + ' Night Vision',
      ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    // Fail gracefully.
    if(!service) {

      this.camera.log.error('Unable to add the night vision dimmer.');

      return false;
    }

    // Adjust night vision capabilities.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.nightVision);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      if(this.nightVision !== value) {

        this.camera.log.info('Night vision %s.', value ? 'enabled' : 'disabled');
      }

      let mode;

      switch(service.getCharacteristic(this.hap.Characteristic.Brightness).value) {

        case 5:

          mode = 'autoFilterOnly';

          break;

        case 10:

          mode = 'auto';

          break;

        default:

          mode = [ 'autoFilterOnly', 'customFilterOnly' ].includes(this.camera.ufp.ispSettings.irLedMode) ? 'customFilterOnly' : 'custom';

          break;
      }

      // Update the night vision setting in Protect.
      const newUfp = await this.camera.nvr.ufpApi.updateDevice(this.camera.ufp, { ispSettings: { irLedMode: value ? mode : 'off' } });

      if(!newUfp) {

        this.camera.log.error('Unable to set night vision to %s. Please ensure this username has the Administrator role in UniFi Protect.',
          value ? mode : 'off');

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), PROTECT_HOMEKIT_UPDATE_DELAY);

        return;
      }

      // Update our internal view of the device configuration.
      this.camera.ufp = newUfp;
    });

    // Adjust the sensitivity of night vision.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.nightVisionBrightness);

    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => {

      let level = value as number;

      // Snap the brightness to the nearest fixed threshold.
      if(level < 5) {

        level = 0;
      } else if(level < 10) {

        level = 5;
      } else if(level < 20) {

        level = 10;
      } else if(level > 90) {

        level = 100;
      }

      // Determine the Protect device settings from the brightness level.
      let nightvision = {};
      const fixedMode = NIGHT_VISION_BRIGHTNESS_MAP.get(level);

      if(fixedMode) {

        nightvision = { ispSettings: { irLedMode: fixedMode } };
      } else {

        // Custom range: map the 20-90 brightness range to the 0-10 icrCustomValue range.
        level = Math.round((level - 20) / 7);

        nightvision = {

          ispSettings: {

            icrCustomValue: level,
            irLedMode: [ 'autoFilterOnly', 'customFilterOnly' ].includes(this.camera.ufp.ispSettings.irLedMode) ? 'customFilterOnly' : 'custom',
          },
        };

        level = (level * 7) + 20;
      }

      const newUfp = await this.camera.nvr.ufpApi.updateDevice(this.camera.ufp, nightvision);

      if(!newUfp) {

        this.camera.log.error('Unable to adjust night vision settings. Please ensure this username has the Administrator role in UniFi Protect.');

        return;
      }

      // Set the context to our updated device configuration.
      this.camera.ufp = newUfp;

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.Brightness, level), PROTECT_HOMEKIT_UPDATE_DELAY);
    });

    // Initialize the dimmer state.
    service.updateCharacteristic(this.hap.Characteristic.On, this.nightVision);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);

    this.camera.log.info('Enabling night vision dimmer.');

    return true;
  }

  // Configure a series of switches to manually enable or disable recording on the UniFi Protect controller for a camera.
  private configureNvrRecordingSwitch(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for recording on a camera: always, detections, and never. We create switches for each of the modes.
    for(const ufpRecordingSwitchType of UFP_RECORDING_SWITCHES) {

      const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf('.') + 1);

      // Validate whether we should have this service enabled.
      if(!validService(this.camera.accessory, this.hap.Service.Switch, this.camera.hints.nvrRecordingSwitch, ufpRecordingSwitchType)) {

        continue;
      }

      const switchName = this.camera.accessoryName + ' UFP Recording ' + toCamelCase(ufpRecordingSetting);

      // Acquire the service.
      const service = acquireService(this.camera.accessory, this.hap.Service.Switch, switchName, ufpRecordingSwitchType);

      // Fail gracefully.
      if(!service) {

        this.camera.log.error('Unable to add UniFi Protect recording switches.');

        continue;
      }

      // Activate or deactivate the appropriate recording mode on the Protect controller.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.camera.ufp.recordingSettings.mode === ufpRecordingSetting);

      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are
        // three different settings one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want.
        if(!value) {

          setTimeout(() => this.camera.updateDevice(), PROTECT_HOMEKIT_UPDATE_DELAY);

          return;
        }

        // Set our recording mode.
        this.camera.ufp.recordingSettings.mode = ufpRecordingSetting;

        // Tell Protect about it.
        const newDevice = await this.camera.nvr.ufpApi.updateDevice(this.camera.ufp, { recordingSettings: this.camera.ufp.recordingSettings });

        if(!newDevice) {

          this.camera.log.error('Unable to set the UniFi Protect recording mode to %s.', ufpRecordingSetting);

          return false;
        }

        // Save our updated device context.
        this.camera.ufp = newDevice;

        // Update all the other recording switches.
        for(const otherUfpSwitch of UFP_RECORDING_SWITCHES) {

          // Don't update ourselves a second time.
          if(ufpRecordingSwitchType === otherUfpSwitch) {

            continue;
          }

          // Update the other recording switches.
          this.camera.accessory.getServiceById(this.hap.Service.Switch, otherUfpSwitch)
            ?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.camera.log.info('UniFi Protect recording mode set to %s.', ufpRecordingSetting);
      });

      // Initialize the recording switch state.
      service.updateCharacteristic(this.hap.Characteristic.On, this.camera.ufp.recordingSettings.mode === ufpRecordingSetting);
      switchesEnabled.push(ufpRecordingSetting);
    }

    if(switchesEnabled.length) {

      this.camera.log.info('Enabling UniFi Protect recording switches: %s.', switchesEnabled.join(', '));
    }

    return true;
  }

  // Configure UniFi Access specific features for devices that are made available in Protect.
  private configureAccessFeatures(): boolean {

    // If the Access device doesn't have unlock capabilities, we're done.
    if(!this.camera.ufp.accessDeviceMetadata?.featureFlags.supportUnlock) {

      return false;
    }

    // Validate whether we should have this service enabled.
    if(!validService(this.camera.accessory, this.hap.Service.LockMechanism, this.camera.hasFeature('UniFi.Access.Lock'),
      ProtectReservedNames.LOCK_ACCESS)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.camera.accessory, this.hap.Service.LockMechanism, this.camera.accessoryName,
      ProtectReservedNames.LOCK_ACCESS);

    // Fail gracefully.
    if(!service) {

      this.camera.log.error('Unable to add lock.');

      return false;
    }

    // Revert the lock to the unsecured state after a brief delay.
    const revertLock = (): void => {

      setTimeout(() => {

        service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
        service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
      }, PROTECT_HOMEKIT_UPDATE_DELAY);
    };

    // Configure the lock current and target state characteristics.
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      // Protect currently only supports unlocking.
      if(value === this.hap.Characteristic.LockTargetState.SECURED) {

        revertLock();

        return;
      }

      // Unlock the Access device.
      const response = await this.camera.nvr.ufpApi.retrieve(
        this.camera.nvr.ufpApi.getApiEndpoint(this.camera.ufp.modelKey) + '/' + this.camera.ufp.id + '/unlock', { method: 'POST' });

      if(!this.camera.nvr.ufpApi.responseOk(response?.statusCode)) {

        // Something went wrong, revert to our prior state.
        revertLock();

        return;
      }
    });

    service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
    service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

    return true;
  }

  // Return the current night vision state of a camera.
  private get nightVision(): boolean {

    return (this.camera.ufp as ProtectCameraConfig).ispSettings.irLedMode !== 'off';
  }

  // Return the current night vision brightness.
  private get nightVisionBrightness(): number {

    const mode = this.camera.ufp.ispSettings.irLedMode;

    // Check the fixed mode-to-brightness mapping first.
    const brightness = NIGHT_VISION_MAP.get(mode);

    if(brightness !== undefined) {

      return brightness;
    }

    // Handle the custom/customFilterOnly interpolated range (20-90).
    if((mode === 'custom') || (mode === 'customFilterOnly')) {

      return (this.camera.ufp.ispSettings.icrCustomValue * 7) + 20;
    }

    this.camera.log.error('Unknown night vision value detected: %s.', mode);

    return 0;
  }
}
