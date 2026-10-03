/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-doorbell-chimes.ts: Physical chime and chime volume delegate for UniFi Protect doorbells.
 */
import type { CharacteristicValue, HAP } from 'homebridge';
import { PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL, PROTECT_HOMEKIT_UPDATE_DELAY } from '../settings.js';
import type { DeepPartial, ProtectChimeConfig, ProtectEventPacket } from '../unifi/index.js';
import { acquireService, validService } from '../lib/index.js';
import type { ProtectDoorbell } from './protect-doorbell.js';
import { ProtectReservedNames } from '../protect-types.js';
import { toCamelCase } from '../protect-utils.js';

// The physical chime modes a Protect doorbell supports.
const PHYSICAL_CHIME_SWITCHES = [

  ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE,
  ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL,
  ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL,
] as const;

export class DoorbellChimes {

  public readonly chimeDigitalDuration: number;
  private readonly doorbell: ProtectDoorbell;
  private readonly hap: HAP;

  constructor(doorbell: ProtectDoorbell) {

    this.doorbell = doorbell;
    this.hap = doorbell.api.hap;

    // Ensure physical chimes that are digital have sane durations.
    this.chimeDigitalDuration = Math.min(Math.max(doorbell.getFeatureNumber('Doorbell.PhysicalChime.Duration.Digital') ?? PROTECT_DOORBELL_CHIME_DURATION_DIGITAL,
      1000), 10000);
  }

  // Configure all chime-related capabilities.
  public configure(): void {

    // Configure physical chime switches, if enabled.
    this.configurePhysicalChimes();

    // Configure volume control, if enabled.
    this.configureVolumeLightbulb();
  }

  // Configure MQTT capabilities for chime volume.
  public configureMqtt(): void {

    // Get and set the chime volume.
    this.doorbell.nvr.mqtt?.subscribeGet(this.doorbell.ufp.mac, 'chime', 'chime volume', (): string => {

      return this.chimeVolume.toString();
    });

    this.doorbell.nvr.mqtt?.subscribeSet(this.doorbell.ufp.mac, 'chime', 'chime volume', (value: string) => {

      const volume = parseInt(value.toString());

      // Unknown message - ignore it.
      if(isNaN(volume) || (volume < 0) || (volume > 100)) {

        return;
      }

      // We explicitly want to trigger our set event handler, which will complete this action.
      this.doorbell.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.Brightness, volume);
      this.doorbell.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.On, volume > 0);
    });
  }

  // Refresh the physical chime switch states, if we have the switches configured on a doorbell that supports chimes.
  public update(): void {

    if(!this.doorbell.ufp.featureFlags.hasChime || !this.doorbell.hasFeature('Doorbell.PhysicalChime')) {

      return;
    }

    // Update state based on the physical chime mode.
    for(const physicalChimeType of PHYSICAL_CHIME_SWITCHES) {

      this.doorbell.accessory.getServiceById(this.hap.Service.Switch, physicalChimeType)
        ?.updateCharacteristic(this.hap.Characteristic.On, this.doorbell.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
    }
  }

  // Handle chime volume updates on the Protect controller.
  public chimeEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as DeepPartial<ProtectChimeConfig>;
    const bootstrap = this.doorbell.nvr.ufpApi.bootstrap;

    // We're only interested in events for this Protect controller and this doorbell.
    if(!bootstrap || (payload.nvrMac !== this.doorbell.nvr.ufp.mac) || !payload.cameraIds?.includes(this.doorbell.ufp.id) || !('ringSettings' in payload)) {

      return;
    }

    const chime = bootstrap.chimes.find(device => packet.header.id === device.id);

    if(chime) {

      bootstrap.chimes = [ ...bootstrap.chimes.filter(device => payload.id !== device.id), Object.assign(chime, payload) ];

      const ring = payload.ringSettings?.find((tone) => tone.cameraId === this.doorbell.ufp.id);

      if(ring && ('volume' in ring)) {

        const service = this.doorbell.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        service?.updateCharacteristic(this.hap.Characteristic.Brightness, ring.volume);
        service?.updateCharacteristic(this.hap.Characteristic.On, (ring.volume) > 0);
      }
    }
  }

  // Return the physical chime duration, in milliseconds.
  public getPhysicalChimeDuration(physicalChimeType: ProtectReservedNames): number {

    // Set the physical chime duration to correspond to the settings that Protect configures when selecting different physical chime types.
    switch(physicalChimeType) {

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL:

        return this.chimeDigitalDuration;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL:

        return PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE:
      default:

        return 0;
    }
  }

  // Configure a series of switches to manually enable or disable chimes on Protect doorbells that support attached physical chimes.
  private configurePhysicalChimes(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for attached, physical chimes on a doorbell: none, mechanical, and digital. We create switches
    // for each of the modes.
    for(const physicalChimeType of PHYSICAL_CHIME_SWITCHES) {

      const chimeSetting = physicalChimeType.slice(physicalChimeType.lastIndexOf('.') + 1);

      // Validate whether we should have this service enabled.
      // If we don't have the physical capabilities or the feature option enabled, disable the switch and we're done.
      if(!validService(this.doorbell.accessory, this.hap.Service.Switch,
        this.doorbell.ufp.featureFlags.hasChime && this.doorbell.hasFeature('Doorbell.PhysicalChime'), physicalChimeType)) {

        continue;
      }

      // Acquire the service.
      const service = acquireService(this.doorbell.accessory, this.hap.Service.Switch,
        this.doorbell.accessoryName + ' Physical Chime ' + toCamelCase(chimeSetting), physicalChimeType);

      // Fail gracefully.
      if(!service) {

        this.doorbell.log.error('Unable to add physical chime switch: %s.', chimeSetting);

        continue;
      }

      // Get the current status of the physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.doorbell.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are
        // three different settings one can choose from. Instead, we do nothing and resync the switch to reflect the actual state in Protect.
        if(!value) {

          setTimeout(() => this.doorbell.updateDevice(), PROTECT_HOMEKIT_UPDATE_DELAY);

          return;
        }

        // Set our physical chime duration. If this fails, HomeKit is informed and reverts the switch.
        await this.doorbell.writeDevice({ chimeDuration: this.getPhysicalChimeDuration(physicalChimeType) },
          'Unable to set the physical chime mode to %s.', chimeSetting);

        // Update all the other physical chime switches.
        for(const otherChimeSwitch of PHYSICAL_CHIME_SWITCHES) {

          // Don't update ourselves a second time.
          if(physicalChimeType === otherChimeSwitch) {

            continue;
          }

          // Update the other physical chime switches.
          this.doorbell.accessory.getServiceById(this.hap.Service.Switch, otherChimeSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.doorbell.log.info('Physical chime type set to %s.', chimeSetting);
      });

      // Initialize the physical chime switch state.
      service.updateCharacteristic(this.hap.Characteristic.On, this.doorbell.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
      switchesEnabled.push(chimeSetting);
    }

    if(switchesEnabled.length) {

      this.doorbell.log.info('Enabling physical chime switches: %s (digital chime duration: %s ms).', switchesEnabled.join(', '),
        this.chimeDigitalDuration.toLocaleString('en-US'));
    }

    return true;
  }

  // Configure the dimmer for HomeKit to control the volume.
  private configureVolumeLightbulb(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.doorbell.accessory, this.hap.Service.Lightbulb, this.doorbell.hasFeature('Doorbell.Volume.Dimmer'),
      ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.doorbell.accessory, this.hap.Service.Lightbulb, this.doorbell.accessoryName + ' Chime Volume',
      ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    if(!service) {

      this.doorbell.log.error('Unable to add chime volume control.');

      return false;
    }

    // Turn the chime on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.chimeVolume > 0);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the volume is zero. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      await this.setChimeVolume(0);
    });

    // Return the volume level of the chime.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.chimeVolume);

    // Adjust the volume of the chime by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => this.setChimeVolume(value as number));

    // Initialize the chime.
    service.updateCharacteristic(this.hap.Characteristic.On, this.chimeVolume > 0);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.chimeVolume);

    this.doorbell.log.info('Enabling Protect chime volume control.');

    return true;
  }

  // Return the average volume across all the chimes associated with this doorbell.
  public get chimeVolume(): number {

    let volume = 0;
    let chimes = 0;

    // If the bootstrap is missing, we're done.
    if(!this.doorbell.nvr.ufpApi.bootstrap) {

      return 0;
    }

    for(const chime of this.doorbell.nvr.ufpApi.bootstrap.chimes.filter(chime => chime.cameraIds.includes(this.doorbell.ufp.id))) {

      const ring = chime.ringSettings.find(ring => ring.cameraId === this.doorbell.ufp.id);

      if(!ring) {

        continue;
      }

      volume += ring.volume;
      chimes++;
    }

    return chimes ? (volume / chimes) : 0;
  }

  // Set the volume across all the chimes associated with this doorbell. Throws a HAP status error if Protect rejects the update.
  private async setChimeVolume(value: number): Promise<void> {

    const bootstrap = this.doorbell.nvr.ufpApi.bootstrap;

    // If the bootstrap is missing, we're done.
    if(!bootstrap) {

      return;
    }

    // Ensure we don't have any negative values.
    value = Math.max(value, 0);

    // Find all the chimes configured for this doorbell so we can sync their volume.
    for(const chime of bootstrap.chimes.filter(chime => chime.cameraIds.includes(this.doorbell.ufp.id))) {

      // Given that chimes can be assigned to multiple doorbells, find the specific entry for this doorbell.
      const ring = chime.ringSettings.find(ring => ring.cameraId === this.doorbell.ufp.id);

      if(!ring) {

        continue;
      }

      // Set the volume and update the chime device. We only update our view of the chime once Protect has accepted the change.
      const newDevice = await this.doorbell.writeDeviceConfig(chime, { ringSettings: [{ ...ring, volume: value }] },
        'Unable to set the chime volume. Please ensure this username has the Administrator role in UniFi Protect.');

      // Set the context to our updated device configuration.
      bootstrap.chimes = [ ...bootstrap.chimes.filter(newChime => newChime.mac !== chime.mac), newDevice ];
    }

    this.doorbell.nvr.mqtt?.publish(this.doorbell.ufp.mac, 'chime', value.toString());
  }
}
