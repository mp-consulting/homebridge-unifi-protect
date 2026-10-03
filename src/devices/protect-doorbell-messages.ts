/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-doorbell-messages.ts: Doorbell LCD message delegate for UniFi Protect doorbells.
 */
import type { CharacteristicValue, HAP, Service } from 'homebridge';
import type { DeepPartial, ProtectCameraLcdMessageConfig, ProtectEventPacket, ProtectNvrConfig } from '../unifi/index.js';
import { acquireService } from '../lib/index.js';
import { PROTECT_DOORBELL_MESSAGE_DURATION } from '../settings.js';
import type { ProtectDoorbell } from './protect-doorbell.js';

// A doorbell message entry.
export interface MessageInterface {

  duration: number;
  text: string;
  type: string;
}

// Extend the message interface to include a doorbell message switch.
export interface MessageSwitchInterface extends MessageInterface {

  service: Service;
  state: boolean;
}

export class DoorbellLcdMessages {

  public readonly defaultMessageDuration: number;
  private readonly doorbell: ProtectDoorbell;
  private readonly hap: HAP;
  private readonly isMessagesEnabled: boolean;
  private readonly isMessagesFromControllerEnabled: boolean;
  public readonly messageSwitches: Record<string, MessageSwitchInterface | undefined>;

  constructor(doorbell: ProtectDoorbell) {

    this.doorbell = doorbell;
    this.hap = doorbell.api.hap;

    this.defaultMessageDuration = doorbell.nvr.ufp.doorbellSettings?.defaultMessageResetTimeoutMs ?? PROTECT_DOORBELL_MESSAGE_DURATION;
    this.isMessagesEnabled = doorbell.hasFeature('Doorbell.Messages');
    this.isMessagesFromControllerEnabled = doorbell.hasFeature('Doorbell.Messages.FromDoorbell');
    this.messageSwitches = {};
  }

  // Configure our access to the doorbell LCD screen.
  public configure(): boolean {

    // Make sure we're configuring a camera device with an LCD screen (aka a doorbell).
    if((this.doorbell.ufp.modelKey !== 'camera') || !this.doorbell.ufp.featureFlags.hasLcdScreen) {

      return false;
    }

    // Grab the consolidated list of messages from the doorbell and our configuration.
    // Look through the combined messages from the doorbell and what the user has configured and tell HomeKit about it.
    for(const entry of this.getMessages()) {

      // Truncate anything longer than the character limit that the doorbell will accept.
      if(entry.text.length > 30) {

        entry.text = entry.text.slice(0, 30);
      }

      const switchIndex = entry.type + '.' + entry.text;

      // In the unlikely event someone tries to use words we have reserved for our own use.
      if(this.doorbell.isReservedName(switchIndex)) {

        continue;
      }

      // Check to see if we already have this message switch configured.
      if(this.messageSwitches[switchIndex]) {

        continue;
      }

      this.doorbell.log.info('Enabled doorbell message switch%s: %s.', entry.duration ? ' (' + (entry.duration / 1000).toString() + ' seconds)' : '',
        entry.text);

      // Acquire the service. Each message cannot exceed 30 characters, but given that HomeKit allows for strings to be up to 64 characters long,
      // this should be fine.
      const service = acquireService(this.doorbell.accessory, this.hap.Service.Switch, entry.text, switchIndex);

      // Fail gracefully.
      if(!service) {

        this.doorbell.log.error('Unable to add doorbell message switch: %s.', entry.text);

        return false;
      }

      const duration = 'duration' in entry ? entry.duration : this.defaultMessageDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches[switchIndex] = { duration: duration, service: service, state: false, text: entry.text, type: entry.type };

      // Configure the message switch.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // Lookup the message switch.
        const messageSwitch = this.messageSwitches[switchIndex];

        // If we're already in the state we want to be in, we're done.
        if(!messageSwitch || (messageSwitch.state === value)) {

          return;
        }

        // Set the message and sync our states.
        await this.setMessage((value === true) ?
          { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } : { resetAt: Date.now() });
      });
    }

    // Update the message switch state in HomeKit.
    if(this.doorbell.ufp.lcdMessage) {

      this.update(this.doorbell.ufp.lcdMessage);
    }

    // Check to see if any of our existing doorbell messages have disappeared.
    this.validateMessageSwitches();

    return true;
  }

  // Configure MQTT capabilities for doorbell messages.
  public configureMqtt(): void {

    // Get the current message on the doorbell.
    this.doorbell.nvr.mqtt?.subscribeGet(this.doorbell.ufp.mac, 'message', 'doorbell message', (): string => {

      if(!this.doorbell.ufp.lcdMessage) {

        return '';
      }

      const resetAt = this.doorbell.ufp.lcdMessage.resetAt;
      const doorbellDuration = (typeof resetAt === 'number') ? Math.round((resetAt - Date.now()) / 1000) : 0;

      // Return the current message.
      return JSON.stringify({ duration: doorbellDuration, message: this.doorbell.ufp.lcdMessage.text ?? '' });
    });

    // We support the ability to set the doorbell message like so:
    //
    //   { "message": "some message", "duration": 30 }
    //
    // If duration is omitted, we assume the default duration.
    // If duration is 0, we assume it's not expiring.
    // If the message is blank, we assume we're resetting the doorbell message.
    this.doorbell.nvr.mqtt?.subscribeSet(this.doorbell.ufp.mac, 'message', 'doorbell message', (_value: string, rawValue: string) => {

      interface mqttMessageJSON {

        message: string;
        duration: number;
      }

      let inboundPayload;

      // Catch any errors in parsing what we get over MQTT.
      try {

        inboundPayload = JSON.parse(rawValue) as mqttMessageJSON;
      } catch(error) {

        this.doorbell.log.error('Unable to process MQTT message: "%s". Invalid JSON.', rawValue);

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have specified duration, make sure it's a valid number.
      if(!('message' in inboundPayload) || (('duration' in inboundPayload) && !Number.isFinite(inboundPayload.duration))) {

        this.doorbell.log.error('Unable to process MQTT message: "%s".', inboundPayload);

        return;
      }

      // If no duration specified, or a negative duration, we assume the default duration.
      if(!('duration' in inboundPayload) || (('duration' in inboundPayload) && (inboundPayload.duration < 0))) {

        inboundPayload.duration = this.defaultMessageDuration;
      } else {

        inboundPayload.duration = inboundPayload.duration * 1000;
      }

      let outboundPayload;

      // No message defined...we assume we're resetting the message.
      if(!inboundPayload.message.length) {

        outboundPayload = { resetAt: Date.now() };
        this.doorbell.log.info('Received MQTT doorbell message reset.');
      } else {

        outboundPayload = { duration: inboundPayload.duration, text: inboundPayload.message, type: 'CUSTOM_MESSAGE' };
        this.doorbell.log.info('Received MQTT doorbell message%s: %s.',
          outboundPayload.duration ? ' (' + (outboundPayload.duration / 1000).toString() + ' seconds)' : '',
          outboundPayload.text);
      }

      // Send it to the doorbell and we're done. Failures to update Protect have already been logged by the time a HAP status error is thrown.
      void this.setMessage(outboundPayload).catch((error: unknown) => {

        if(!(error instanceof this.hap.HapStatusError)) {

          this.doorbell.log.error('Unable to set doorbell message: %s.', error);
        }
      });
    });
  }

  // Handle doorbell saved message updates on the Protect controller.
  public nvrEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as DeepPartial<ProtectNvrConfig>;

    // Process doorbell message save events.
    if(payload.doorbellSettings) {

      // We need to proactively update the allMessages object. This feels like a UniFi Protect bug, but all we can do is work around it.
      if(payload.doorbellSettings.customMessages && this.doorbell.nvr.ufp.doorbellSettings) {

        const builtinMessages = this.doorbell.nvr.ufp.doorbellSettings.allMessages.filter(x => x.type !== 'CUSTOM_MESSAGE');
        const customMessages = payload.doorbellSettings.customMessages.map((x: string) => ({ text: x, type: 'CUSTOM_MESSAGE' }));

        this.doorbell.nvr.ufp.doorbellSettings.allMessages = builtinMessages.concat(customMessages);
      }

      this.configure();
    }
  }

  // Update the message switch state in HomeKit.
  public update(payload: DeepPartial<ProtectCameraLcdMessageConfig>): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(payload).length) {

      for(const entry of Object.keys(this.messageSwitches)) {

        if(!this.messageSwitches[entry]) {

          continue;
        }

        this.messageSwitches[entry].state = false;
        this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, false);
      }

      return;
    }

    // Sanity check.
    if(!('type' in payload) || !('text' in payload)) {

      return;
    }

    // The message has been set on the doorbell. Update HomeKit accordingly.
    for(const entry of Object.keys(this.messageSwitches)) {

      if(!this.messageSwitches[entry]) {

        continue;
      }

      // If it's not the message we're interested in, make sure it's off and keep going.
      if(entry !== ((payload.type) + '.' + (payload.text))) {

        this.messageSwitches[entry].state = false;
        this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, false);

        continue;
      }

      // If the message switch is already on, we're done.
      if(this.messageSwitches[entry].state) {

        continue;
      }

      // Set the message state and update HomeKit.
      this.messageSwitches[entry].state = true;
      this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, true);

      this.doorbell.log.info('Doorbell message set%s: %s.',
        payload.resetAt !== null ? ' (' + Math.round(((payload.resetAt ?? 0) - Date.now()) / 1000).toString() + ' seconds)' : '', payload.text);

      // Publish to MQTT, if the user has configured it.
      this.doorbell.nvr.mqtt?.publish(this.doorbell.ufp.mac, 'message',
        JSON.stringify({ duration: this.messageSwitches[entry].duration / 1000, message: this.messageSwitches[entry].text }));
    }
  }

  // Get the list of messages from the doorbell and the user configuration.
  private getMessages(): MessageInterface[] {

    // First, we get our builtin and configured messages from the controller.
    const doorbellSettings = this.doorbell.nvr.ufp.doorbellSettings;

    // Something's not right with the configuration...we're done.
    if(!doorbellSettings || !this.isMessagesEnabled) {

      return [];
    }

    let doorbellMessages: MessageInterface[] = [];

    // Grab any messages that the user has configured.
    if(this.doorbell.nvr.config.doorbellMessages) {

      for(const configEntry of this.doorbell.nvr.config.doorbellMessages) {

        let duration = this.defaultMessageDuration;

        // If we've set a duration, let's honor it. If it's less than zero, use the default duration.
        if(('duration' in configEntry) && !isNaN(configEntry.duration) && (configEntry.duration >= 0)) {

          duration = configEntry.duration * 1000;
        }

        // Add it to our list.
        doorbellMessages.push({ duration: duration, text: configEntry.message, type: 'CUSTOM_MESSAGE' });
      }
    }

    // If we've got messages on the controller, let's configure those, unless the user has disabled that feature.
    if(this.isMessagesFromControllerEnabled) {

      doorbellMessages = (doorbellSettings.allMessages as MessageInterface[]).concat(doorbellMessages);
    }

    // Return the list of doorbell messages.
    return doorbellMessages;
  }

  // Validate our existing HomeKit message switch list.
  private validateMessageSwitches(): void {

    // Figure out if there's anything that's disappeared in the canonical list from the doorbell.
    for(const entry of Object.values(this.messageSwitches)) {

      // This exists on the doorbell...move along.
      if(!entry || this.messageSwitches[entry.type + '.' + entry.text]) {

        continue;
      }

      this.doorbell.log.info('Removing saved doorbell message: %s.', entry.text);

      // The message has been deleted on the doorbell, remove it in HomeKit.
      this.doorbell.accessory.removeService(entry.service);
      delete this.messageSwitches[entry.type + '.' + entry.text];
    }

    // Loop through the list of services on our doorbell accessory and sync the message switches. We do this to catch the scenario where Homebridge
    // was shutdown, and the list of saved messages on the controller changes.
    for(const switchService of this.doorbell.accessory.services.filter(service => (service.UUID === this.hap.Service.Switch.UUID) && service.subtype &&
      !this.doorbell.isReservedName(service.subtype) && !this.messageSwitches[service.subtype])) {

      // The message has been deleted on the doorbell - remove it from HomeKit and inform the user about it.
      this.doorbell.log.info('Removing saved doorbell message: %s.', switchService.subtype?.slice(switchService.subtype.indexOf('.') + 1));
      this.doorbell.accessory.removeService(switchService);
    }
  }

  // Set the message on the doorbell. Throws a HAP status error if Protect rejects the update.
  private async setMessage(payload: DeepPartial<ProtectCameraLcdMessageConfig> = {}): Promise<void> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if('duration' in payload) {

      payload.resetAt = payload.duration ? Date.now() + payload.duration : null;
      delete payload.duration;
    }

    // Push the update to the doorbell. If we have an empty payload, it means we're resetting the LCD message back to it's default.
    await this.doorbell.writeDevice({ lcdMessage: payload },
      'Unable to set doorbell message. Please ensure this username has the Administrator role in UniFi Protect.');
  }
}
