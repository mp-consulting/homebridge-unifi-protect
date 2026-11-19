/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import type { Characteristic, CharacteristicValue, HAP, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { DeepPartial, ProtectEventPacket, ProtectSensorConfig, ProtectSensorSmokeStatus } from '../unifi/index.js';
import { SMOKE_ALARM_TYPES, type SmokeAlarmType, type SmokeFaultReason, carbonMonoxideDetected, carbonMonoxideFaultReasons, smokeAlarmCapable,
  smokeDetected, smokeDetectorHardware, smokeFaultReasons } from './protect-sensor-smoke.js';
import { HOMEKIT_AMBIENT_LIGHT_MINIMUM } from '../settings.js';
import type { Nullable } from '../lib/index.js';
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

// The definition of one of the sensor services of a smoke detector. Every one of them follows the same template, so the services we create, what we log, and
// the MQTT topics we use all come from this one description.
interface SmokeAlarmDefinition {

  // The alarm type the detector must advertise for this sensor to exist.
  alarmType: SmokeAlarmType;

  // The characteristic that holds the alarm state.
  characteristic: (hap: HAP) => WithUUID<new () => Characteristic>;

  // Whether the detector is reporting this alarm.
  detected: (status: ProtectSensorSmokeStatus) => boolean;

  // The detector fault flags that stand against this sensor.
  faultReasons: (status: ProtectSensorSmokeStatus) => SmokeFaultReason[];

  // A human-readable description used when logging.
  label: string;

  // The MQTT topic we publish the alarm state to.
  mqtt: string;

  // What we append to the accessory name to name the service, so that HomeKit shows the two sensors of a detector under different names.
  name: string;

  // The HomeKit service type for the sensor.
  serviceType: (hap: HAP) => WithUUID<typeof Service>;
}

// The sensors of a smoke detector, in the order we report them.
const SMOKE_ALARMS: readonly SmokeAlarmDefinition[] = [

  { alarmType: SMOKE_ALARM_TYPES.carbonMonoxide, characteristic: (hap): WithUUID<new () => Characteristic> => hap.Characteristic.CarbonMonoxideDetected,
    detected: carbonMonoxideDetected, faultReasons: carbonMonoxideFaultReasons, label: 'carbon monoxide', mqtt: 'carbonmonoxide', name: ' Carbon Monoxide',
    serviceType: (hap): WithUUID<typeof Service> => hap.Service.CarbonMonoxideSensor },
  { alarmType: SMOKE_ALARM_TYPES.smoke, characteristic: (hap): WithUUID<new () => Characteristic> => hap.Characteristic.SmokeDetected,
    detected: smokeDetected, faultReasons: smokeFaultReasons, label: 'smoke', mqtt: 'smoke', name: ' Smoke',
    serviceType: (hap): WithUUID<typeof Service> => hap.Service.SmokeSensor },
];

// How we describe each smoke detector fault when logging.
const SMOKE_FAULT_LABELS: Readonly<Record<SmokeFaultReason, string>> = {

  cleanSmokeSensor: 'needs cleaning',
  coSensorFault: 'sensor fault',
  endOfLife: 'end of life',
  smokeSensorFault: 'sensor fault',
};

export class ProtectSensor extends ProtectDevice {

  private enabledSensors: string[];
  private lastAlarm?: boolean;
  private lastLeak: Record<string, boolean | undefined>;
  private lastSmoke: Partial<Record<SmokeAlarmType, { detected: boolean; faults: string }>>;
  private lastSmokeTesting?: boolean;
  public override ufp: ProtectSensorConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectSensorConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.enabledSensors = [];
    this.lastLeak = {};
    this.lastSmoke = {};
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

    // Configure the smoke and carbon monoxide sensors of a smoke detector.
    currentEnabledSensors.push(...this.configureSmokeDetector());

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

  // Configure the smoke and carbon monoxide sensors of a smoke detector for HomeKit, and return the sensors we have enabled. Each sensor only exists on smoke
  // detector hardware that advertises the corresponding alarm type. There is no feature option to turn them on: smoke and carbon monoxide alarms have a direct
  // HomeKit equivalent, and they are critical alerts in HomeKit.
  private configureSmokeDetector(): string[] {

    const alarmTypes = this.smokeAlarmTypes;
    const enabled: string[] = [];
    const status = this.ufp.smokeStatus;

    for(const alarm of SMOKE_ALARMS) {

      const characteristic = alarm.characteristic(this.hap);
      const serviceType = alarm.serviceType(this.hap);

      // Validate whether we should have this service enabled.
      if(!this.validService(serviceType, smokeAlarmCapable(alarmTypes, alarm.alarmType))) {

        // Without a service, there's no state to track. Should the sensor return, we start again from its first reading.
        delete this.lastSmoke[alarm.alarmType];

        continue;
      }

      // Acquire the service.
      const service = this.acquireService(serviceType, this.accessoryName + alarm.name);

      // Fail gracefully.
      if(!service) {

        this.log.error('Unable to add the %s sensor.', alarm.label);

        continue;
      }

      // Retrieve the current alarm and fault states when requested.
      service.getCharacteristic(characteristic).onGet(() => this.smokeAlarmState(alarm));
      service.getCharacteristic(this.hap.Characteristic.StatusFault).onGet(() => this.smokeFaultState(alarm));

      // We only update the sensor when the detector is reporting its status. When it isn't, HomeKit keeps the last state the detector reported, and we say and
      // publish nothing: a gap in reporting must never clear an alarm that the detector really did raise.
      if(status) {

        const detected = alarm.detected(status);
        const reasons = alarm.faultReasons(status);
        const faults = reasons.join(',');
        const last = this.lastSmoke[alarm.alarmType];

        // Inform the user when an alarm starts or stops. On our first reading, we only do so if the alarm is already sounding.
        if(last ? (detected !== last.detected) : detected) {

          this.log.info('%s %sdetected.', alarm.label.charAt(0).toUpperCase() + alarm.label.slice(1), detected ? '' : 'no longer ');
        }

        // Inform the user when the faults being reported change. We compare the reasons rather than whether there is a fault at all, so that a detector that
        // develops a second fault says so.
        if(last ? (faults !== last.faults) : (reasons.length > 0)) {

          if(reasons.length) {

            this.log.warn('The %s sensor is reporting a fault: %s.', alarm.label, reasons.map(reason => SMOKE_FAULT_LABELS[reason]).join(', '));
          } else {

            this.log.info('The %s sensor is no longer reporting a fault.', alarm.label);
          }
        }

        this.lastSmoke[alarm.alarmType] = { detected, faults };

        // Update the sensor.
        service.updateCharacteristic(characteristic, detected);
        service.updateCharacteristic(this.hap.Characteristic.StatusFault, reasons.length > 0);

        // Publish the state.
        this.publish(alarm.mqtt, detected.toString());
      }

      // Update the state characteristics.
      this.configureStateCharacteristics(service);

      enabled.push(alarm.label);
    }

    // If this isn't a smoke detector, we're done.
    if(!enabled.length) {

      delete this.lastSmokeTesting;

      return enabled;
    }

    if(status) {

      // Inform the user when a self-test starts or ends. On our first reading, we only do so if a self-test is already under way.
      if((this.lastSmokeTesting === undefined) ? status.testing : (status.testing !== this.lastSmokeTesting)) {

        this.log.info('The smoke detector\'s self-test has %s.', status.testing ? 'started' : 'ended');
      }

      this.lastSmokeTesting = status.testing;

      // Publish the full status of the detector.
      const detectorStatus = this.smokeDetectorStatus;

      if(detectorStatus !== null) {

        this.publish('smokedetector', detectorStatus);
      }
    }

    return enabled;
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

  // Get the alarm types that this sensor's smoke detector hardware advertises. A sensor that isn't a smoke detector advertises none, whatever the controller
  // says: a sensor that only listens for the sound of alarms advertises the same alarm types that a detector does.
  private get smokeAlarmTypes(): readonly string[] {

    return smokeDetectorHardware(this.ufp) ? (this.ufp.featureFlags?.alarmTypes ?? []) : [];
  }

  // Get the current alarm state for one of the sensors of a smoke detector. When the detector isn't reporting its status, we answer with the state that HomeKit
  // already has rather than an all-clear that the detector never sent. That includes the state restored from the accessory cache after a restart.
  private smokeAlarmState(alarm: SmokeAlarmDefinition): boolean {

    if(!smokeAlarmCapable(this.smokeAlarmTypes, alarm.alarmType)) {

      return false;
    }

    if(this.ufp.smokeStatus) {

      return alarm.detected(this.ufp.smokeStatus);
    }

    return !!this.accessory.getService(alarm.serviceType(this.hap))?.getCharacteristic(alarm.characteristic(this.hap)).value;
  }

  // Get the current fault state for one of the sensors of a smoke detector. As with the alarm state, we answer with what HomeKit already has when the detector
  // isn't reporting its status.
  private smokeFaultState(alarm: SmokeAlarmDefinition): boolean {

    if(!smokeAlarmCapable(this.smokeAlarmTypes, alarm.alarmType)) {

      return false;
    }

    if(this.ufp.smokeStatus) {

      return alarm.faultReasons(this.ufp.smokeStatus).length > 0;
    }

    return !!this.accessory.getService(alarm.serviceType(this.hap))?.getCharacteristic(this.hap.Characteristic.StatusFault).value;
  }

  // Get the full status of a smoke detector as JSON, or null if this isn't a smoke detector or it isn't reporting its status. We build this member by member
  // rather than passing along whatever the controller sends, so that the topic carries exactly what we document.
  private get smokeDetectorStatus(): Nullable<string> {

    const status = this.ufp.smokeStatus;

    if(!status || !SMOKE_ALARMS.some(alarm => smokeAlarmCapable(this.smokeAlarmTypes, alarm.alarmType))) {

      return null;
    }

    return JSON.stringify({

      alarmSilenced: status.alarmSilenced,
      alarmSilencedAt: this.ufp.alarmSilencedAt ?? null,
      batteryLow: status.batteryLow,
      batteryVoltage: status.batteryVoltage,
      cleanSmokeSensor: status.cleanSmokeSensor,
      coAlarm: status.coAlarm,
      coAlarmTriggeredAt: this.ufp.coAlarmTriggeredAt ?? null,
      coSensorFault: status.coSensorFault,
      coValue: status.coValue,
      enabled: status.enabled,
      endOfLife: status.endOfLife,
      ready: status.ready,
      smokeAlarm: status.smokeAlarm,
      smokeAlarmTriggeredAt: this.ufp.smokeAlarmTriggeredAt ?? null,
      smokeSensorFault: status.smokeSensorFault,
      smokeValue: status.smokeValue,
      testing: status.testing,
      troubleHushed: status.troubleHushed,
      troubleSilencedAt: this.ufp.troubleSilencedAt ?? null,
      wasMounted: status.wasMounted,
    });
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

    // The smoke detector topics only exist on smoke detectors. A sensor's model never changes, so we only need to decide this once.
    if(smokeDetectorHardware(this.ufp)) {

      for(const alarm of SMOKE_ALARMS) {

        this.subscribeGet(alarm.mqtt, alarm.label + ' detected', () => this.smokeAlarmState(alarm).toString());
      }

      this.subscribeGet('smokedetector', 'smoke detector', () => this.smokeDetectorStatus ?? 'null');
    }
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
