/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import type { DeepPartial, ProtectEventPacket, ProtectSensorConfig } from '../unifi/index.js';
import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { HOMEKIT_AMBIENT_LIGHT_MINIMUM } from '../settings.js';
import type { ProtectAccessoryContext } from './protect-accessory-context.js';
import { ProtectDevice } from './protect-device.js';
import type { ProtectNvr } from '../protect-nvr.js';
import { ProtectReservedNames } from '../protect-types.js';

// The definition of a simple, single-characteristic sensor service.
export interface SimpleSensorDefinition {

  // The characteristic that holds the sensor reading.
  characteristic: WithUUID<new () => Characteristic>;

  // Whether the sensor should be exposed to HomeKit.
  isEnabled: boolean;

  // A human-readable description used in error messages.
  label: string;

  // The MQTT topic we publish the sensor reading to.
  mqtt: string;

  // The value we publish to MQTT.
  mqttValue: () => string;

  // The service name. Defaults to the accessory name.
  name?: string;

  // Whether we should publish the reading to MQTT. Defaults to true.
  publishIf?: boolean;

  // The HomeKit service type for the sensor.
  serviceType: WithUUID<typeof Service>;

  // The service subtype, if any.
  subtype?: string;

  // The current sensor reading for HomeKit.
  value: () => CharacteristicValue;
}

export class ProtectSensor extends ProtectDevice {

  private enabledSensors: string[];
  private lastAlarm?: boolean;
  private lastLeak: Record<string, boolean | undefined>;
  public override ufp: ProtectSensorConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectSensorConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.enabledSensors = [];
    this.lastLeak = {};
    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Initialize and configure the sensor accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = { mac: this.ufp.mac, nvr: this.nvr.ufp.mac } satisfies ProtectAccessoryContext;

    // Configure accessory information.
    this.configureInfo();

    // Configure the battery status.
    this.configureBatteryService();

    // Configure the sensor services that have been enabled.
    this.updateDevice(false);

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.subscribe('updateEvent.' + this.ufp.id, (packet) => this.eventHandler(packet));

    return true;
  }

  // Update battery status information for HomeKit.
  private configureBatteryService(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Battery);

    // Fail gracefully.
    if(!service) {

      this.log.error('Unable to add the battery service.');

      return false;
    }

    // Initialize the battery state.
    this.updateBatteryStatus();

    return true;
  }

  // Update accessory services and characteristics.
  private updateDevice(isInitialized = true): void {

    const currentEnabledSensors: string[] = [];

    // Update the battery status for the accessory.
    this.updateBatteryStatus();

    // Configure the alarm sound sensor.
    if(this.configureAlarmSoundSensor()) {

      currentEnabledSensors.push('alarm sound');
    }

    // Configure the ambient light sensor.
    if(this.configureAmbientLightSensor()) {

      currentEnabledSensors.push('ambient light');
    }

    // Configure the contact sensor.
    if(this.configureContactSensor()) {

      currentEnabledSensors.push('contact');
    }

    // Configure the humidity sensor.
    if(this.configureHumiditySensor()) {

      currentEnabledSensors.push('humidity');
    }

    // Configure the leak sensor.
    if(this.configureLeakSensor()) {

      const sensorType = this.hasFeature('Sensor.MoistureSensor') ? 'moisture' : 'leak';

      if(this.ufp.leakSettings.isInternalEnabled) {

        currentEnabledSensors.push(sensorType);
      }

      if(this.ufp.leakSettings.isExternalEnabled) {

        currentEnabledSensors.push(sensorType + ' (external)');
      }
    }

    // Configure the motion sensor.
    if(this.configureMotionSensor(this.ufp.motionSettings.isEnabled, isInitialized)) {

      // Sensor accessories also support battery, connection, and tamper status...we need to handle those ourselves.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      currentEnabledSensors.push('motion sensor');
    }

    // Configure the occupancy sensor.
    this.configureOccupancySensor(this.ufp.motionSettings.isEnabled, isInitialized);

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor()) {

      currentEnabledSensors.push('temperature');
    }

    // Update the status indicator light switch.
    this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)
      ?.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);

    // Inform the user if we've had a change.
    if(this.enabledSensors.join(' ') !== currentEnabledSensors.join(' ')) {

      this.enabledSensors = currentEnabledSensors;

      // Inform the user what we're enabling on startup.
      if(this.enabledSensors.length) {

        this.log.info('Enabled sensor%s: %s.', this.enabledSensors.length > 1 ? 's' : '', this.enabledSensors.join(', '));
      } else {

        this.log.info('No sensors enabled.');
      }
    }
  }

  // Configure a simple, single-characteristic sensor service for HomeKit. Every sensor we expose follows the same template: validate whether the service
  // should exist, acquire it, wire up the read handler, refresh the current value and state characteristics, and publish the value to MQTT.
  private configureSimpleSensor(sensor: SimpleSensorDefinition): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(sensor.serviceType, sensor.isEnabled, sensor.subtype)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(sensor.serviceType, sensor.name, sensor.subtype);

    // Fail gracefully.
    if(!service) {

      this.log.error('Unable to add ' + sensor.label + '.');

      return false;
    }

    // Retrieve the current sensor state when requested.
    service.getCharacteristic(sensor.characteristic).onGet(() => sensor.value());

    // Update the sensor.
    service.updateCharacteristic(sensor.characteristic, sensor.value());

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    if(sensor.publishIf ?? true) {

      this.publish(sensor.mqtt, sensor.mqttValue());
    }

    return true;
  }

  // Configure the alarm sound sensor for HomeKit.
  private configureAlarmSoundSensor(): boolean {

    return this.configureSimpleSensor({

      characteristic: this.hap.Characteristic.ContactSensorState,
      isEnabled: this.ufp.alarmSettings.isEnabled,
      label: 'alarm sound contact sensor',
      mqtt: 'alarm',
      mqttValue: () => this.alarmDetected.toString(),
      name: this.accessoryName + ' Alarm Sound',
      serviceType: this.hap.Service.ContactSensor,
      subtype: ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND,
      value: () => this.alarmDetected,
    });
  }

  // Configure the ambient light sensor for HomeKit.
  private configureAmbientLightSensor(): boolean {

    return this.configureSimpleSensor({

      characteristic: this.hap.Characteristic.CurrentAmbientLightLevel,
      isEnabled: this.ufp.lightSettings.isEnabled,
      label: 'ambient light sensor',
      mqtt: 'ambientlight',
      mqttValue: () => this.ambientLight.toString(),
      serviceType: this.hap.Service.LightSensor,
      value: () => Math.max(this.ambientLight, HOMEKIT_AMBIENT_LIGHT_MINIMUM),
    });
  }

  // Configure the contact sensor for HomeKit.
  private configureContactSensor(): boolean {

    return this.configureSimpleSensor({

      characteristic: this.hap.Characteristic.ContactSensorState,
      isEnabled: !!this.ufp.mountType && (this.ufp.mountType !== 'leak') && (this.ufp.mountType !== 'none'),
      label: 'contact sensor',
      mqtt: 'contact',
      mqttValue: () => this.contact.toString(),
      serviceType: this.hap.Service.ContactSensor,
      subtype: ProtectReservedNames.CONTACT_SENSOR,
      value: () => this.contact,
    });
  }

  // Configure the humidity sensor for HomeKit.
  private configureHumiditySensor(): boolean {

    return this.configureSimpleSensor({

      characteristic: this.hap.Characteristic.CurrentRelativeHumidity,
      isEnabled: this.ufp.humiditySettings.isEnabled,
      label: 'humidity sensor',
      mqtt: 'humidity',
      mqttValue: () => this.humidity.toString(),
      serviceType: this.hap.Service.HumiditySensor,
      value: () => this.humidity < 0 ? 0 : this.humidity,
    });
  }

  // Configure the leak sensor for HomeKit.
  private configureLeakSensor(): boolean {

    // Determine which service and characteristic types to use based on whether we are configured as a moisture sensor.
    const isMoistureSensor = this.hasFeature('Sensor.MoistureSensor');
    const characteristic = isMoistureSensor ? this.hap.Characteristic.ContactSensorState : this.hap.Characteristic.LeakDetected;
    const removeServiceType = isMoistureSensor ? this.hap.Service.LeakSensor : this.hap.Service.ContactSensor;
    const sensorType = isMoistureSensor ? 'contact sensor' : 'leak sensor';
    const serviceType = isMoistureSensor ? this.hap.Service.ContactSensor : this.hap.Service.LeakSensor;

    let count = 0;

    for(const sensor of [

      { isDetected: 'externalLeakDetectedAt', isEnabled: this.ufp.leakSettings.isExternalEnabled, mqtt: 'leak-external',
        name: ' External ' + (isMoistureSensor ? 'Moisture' : 'Leak') + ' Sensor', subtype: ProtectReservedNames.LEAKSENSOR_EXTERNAL },
      { isDetected: 'leakDetectedAt', isEnabled: this.ufp.leakSettings.isInternalEnabled, mqtt: 'leak', subtype: ProtectReservedNames.LEAKSENSOR_INTERNAL },
    ]) {

      // Remove the opposite sensor type if it exists since we are switching between sensor configurations.
      const oldService = this.accessory.getServiceById(removeServiceType, sensor.subtype);

      if(oldService) {

        this.accessory.removeService(oldService);
      }

      if(this.configureSimpleSensor({

        characteristic: characteristic,
        isEnabled: sensor.isEnabled,
        label: sensorType,
        mqtt: sensor.mqtt,
        mqttValue: () => this.leakDetected(sensor.isDetected).toString(),
        name: this.accessoryName + (sensor.name ?? ''),
        publishIf: this.ufp.isConnected,
        serviceType: serviceType,
        subtype: sensor.subtype,
        value: () => this.leakDetected(sensor.isDetected),
      })) {

        count++;
      }
    }

    return count > 0;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    return this.configureSimpleSensor({

      characteristic: this.hap.Characteristic.CurrentTemperature,
      isEnabled: this.ufp.temperatureSettings.isEnabled,
      label: 'temperature sensor',
      mqtt: 'temperature',
      mqttValue: () => this.temperature.toString(),
      serviceType: this.hap.Service.TemperatureSensor,
      value: () => this.temperature,
    });
  }

  // Update the battery status in HomeKit.
  private updateBatteryStatus(): boolean {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // Update the battery status.
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.ufp.batteryStatus.percentage ?? 0);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus.isLow);

    return true;
  }

  // Configure the additional state characteristics in HomeKit.
  private configureStateCharacteristics(service: Service): boolean {

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isOnline);

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(() => this.ufp.tamperingDetectedAt !== null);

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.ufp.tamperingDetectedAt !== null);

    return true;
  }

  // Get the current alarm alert detection information.
  private get alarmDetected(): boolean {

    return this.ufp.alarmTriggeredAt !== null;
  }

  // Track alarm state changes and log transitions.
  private updateAlarmState(): void {

    const value = this.alarmDetected;

    if(value !== this.lastAlarm) {

      this.lastAlarm = value;

      this.log.info('Alarm %sdetected.', value ? '' : 'no longer ');
    }
  }

  // Get the current ambient light information.
  private get ambientLight(): number {

    return this.ufp.stats?.light?.value ?? -1;
  }

  // Get the current contact sensor information.
  private get contact(): boolean {

    return !!this.ufp.isOpened;
  }

  // Get the current humidity information.
  private get humidity(): number {

    return this.ufp.stats?.humidity?.value ?? -1;
  }

  // Get the current leak sensor information.
  private leakDetected(type = 'leakDetectedAt'): boolean {

    // Return true if we are not null, meaning a leak has been detected.
    const value = this.ufp[type] !== null;

    // If it's our first run, just save the state and we're done if we don't have a leak. If we do have a leak, make sure we inform the user.
    if((this.lastLeak[type] === undefined) && !value) {

      this.lastLeak[type] = value;

      return value;
    }

    // Save the state change and publish to MQTT.
    if(value !== this.lastLeak[type]) {

      this.lastLeak[type] = value;

      this.log.info('%s %sdetected.', this.hasFeature('Sensor.MoistureSensor') ? 'Moisture' : 'Leak', value ? '' : 'no longer ');
    }

    return value;
  }

  // Get the current temperature information.
  private get temperature(): number {

    return this.ufp.stats?.temperature?.value ?? -1;
  }

  // Configure MQTT capabilities for sensors.
  private configureMqtt(): void {

    this.subscribeGet('alarm', 'alarm detected', () => this.alarmDetected.toString());
    this.subscribeGet('ambientlight', 'ambient light', () => this.ambientLight.toString());
    this.subscribeGet('contact', 'contact sensor', () => this.contact.toString());
    this.subscribeGet('humidity', 'humidity', () => this.humidity.toString());
    this.subscribeGet('leak', 'leak detected', () => this.leakDetected().toString());
    this.subscribeGet('leak-external', 'leak detected', () => this.leakDetected('externalLeakDetectedAt').toString());
    this.subscribeGet('temperature', 'temperature', () => this.temperature.toString());
  }

  // Handle sensor-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as DeepPartial<ProtectSensorConfig>;

    // It's a motion event - process it accordingly.
    if(payload.motionDetectedAt) {

      this.nvr.events.motionEventHandler(this);
    }

    // Track alarm state transitions.
    this.updateAlarmState();

    // Process it.
    this.updateDevice();
  }
}
