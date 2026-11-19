/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * devices.test.ts: Tests for the device class lifecycle: Protect writes, event subscriptions, cleanup, and table-driven sensor configuration.
 */
import * as hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PlatformAccessory } from 'homebridge';
import { ProtectCameraPackage } from '../src/devices/protect-camera-package.js';
import { ProtectDoorbell } from '../src/devices/protect-doorbell.js';
import type { ProtectNvr } from '../src/protect-nvr.js';
import { ProtectNvrSystemInfo } from '../src/devices/protect-nvr-systeminfo.js';
import { ProtectReservedNames } from '../src/protect-types.js';
import { ProtectSensor } from '../src/devices/protect-sensor.js';

// Features that are enabled in our fake feature option configuration.
let enabledFeatures: Set<string>;

// Build a minimal fake NVR, with the real HAP and an event emitter for controller events.
function makeNvr(): ProtectNvr & { events: EventEmitter; mqttPublished: [string, string][]; ufpApi: { updateDevice: ReturnType<typeof vi.fn> } } {

  const events = Object.assign(new EventEmitter(), { doorbellEventHandler: vi.fn(), motionEventHandler: vi.fn() });
  const mqttPublished: [string, string][] = [];
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  const platform = {

    accessories: [] as PlatformAccessory[],
    api: { hap, platformAccessory: makeAccessory, registerPlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(),
      updatePlatformAccessories: vi.fn() },
    debug: vi.fn(),
    featureOptions: {

      getFloat: (): null => null,
      getInteger: (): null => null,
      scope: (): string => 'global',
      test: (option: string): boolean => enabledFeatures.has(option),
      value: (): null => null,
    },
    log,
  };

  return {

    config: { doorbellMessages: [] },
    events,
    getDeviceById: (): null => null,
    hasFeature: (option: string): boolean => enabledFeatures.has(option),
    logFeature: vi.fn(),
    mqtt: {

      publish: (_id: string, topic: string, message: string): number => mqttPublished.push([ topic, message ]),
      subscribeGet: vi.fn(),
      subscribeSet: vi.fn(),
      unsubscribe: vi.fn(),
    },
    mqttPublished,
    platform,
    ufp: { doorbellSettings: { allMessages: [], defaultMessageResetTimeoutMs: 60000 }, id: 'nvr-id', mac: 'NVRMAC', name: 'NVR',
      systemInfo: { cpu: { temperature: 42 } } },
    ufpApi: { bootstrap: null, getDeviceName: (device: { name: string }): string => device.name, name: 'NVR', updateDevice: vi.fn() },
  } as unknown as ProtectNvr & { events: EventEmitter; mqttPublished: [string, string][]; ufpApi: { updateDevice: ReturnType<typeof vi.fn> } };
}

// Create a HAP accessory that stands in for a Homebridge platform accessory.
function makeAccessory(name = 'Test Device', uuid = hap.uuid.generate(name)): PlatformAccessory {

  const accessory = new hap.Accessory(name, uuid);

  return Object.assign(accessory, { _associatedHAPAccessory: accessory, configureController: vi.fn(), context: {}, removeController: vi.fn() }) as unknown as
    PlatformAccessory;
}

// A sample UniFi Protect sensor payload with every sensor type enabled.
function makeSensorConfig(): Record<string, unknown> {

  return {

    alarmSettings: { isEnabled: true },
    alarmTriggeredAt: null,
    batteryStatus: { isLow: false, percentage: 90 },
    externalLeakDetectedAt: null,
    firmwareVersion: '1.0.0',
    humiditySettings: { isEnabled: true },
    id: 'sensor-id',
    isConnected: true,
    isOpened: false,
    leakDetectedAt: 1,
    leakSettings: { isExternalEnabled: true, isInternalEnabled: true },
    ledSettings: { isEnabled: true },
    lightSettings: { isEnabled: true },
    mac: 'SENSORMAC',
    marketName: 'UP Sense',
    modelKey: 'sensor',
    motionSettings: { isEnabled: true },
    mountType: 'door',
    name: 'Front Door',
    stats: { humidity: { value: 45 }, light: { value: 0 }, temperature: { value: 21.5 } },
    tamperingDetectedAt: null,
    temperatureSettings: { isEnabled: true },
    type: 'UFP-SENSE',
  };
}

// The status block a healthy UniFi Protect smoke detector reports at rest. Tests name only the members they move.
function makeSmokeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return { alarmSilenced: false, batteryLow: false, batteryVoltage: 0, cleanSmokeSensor: false, coAlarm: false, coSensorFault: false, coValue: 0, enabled: true,
    endOfLife: false, ready: true, smokeAlarm: false, smokeSensorFault: false, smokeValue: 0, testing: false, troubleHushed: false, wasMounted: true,
    ...overrides };
}

// A sample UniFi Protect smoke detector payload: a USL Smoke at rest, with none of the other sensor types enabled.
function makeSmokeDetectorConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return {

    alarmSettings: { isEnabled: false },
    alarmSilencedAt: null,
    alarmTriggeredAt: null,
    batteryStatus: { isLow: false, percentage: 100 },
    coAlarmTriggeredAt: null,
    externalLeakDetectedAt: null,
    featureFlags: { alarmTypes: [ 'smoke', 'CO' ], button: { channelCount: 1 }, isBidirectional: true, smoke: { channelCount: 1 } },
    firmwareVersion: '1.0.0',
    humiditySettings: { isEnabled: false },
    id: 'sensor-id',
    isConnected: true,
    isOpened: null,
    leakDetectedAt: null,
    leakSettings: { isExternalEnabled: false, isInternalEnabled: false },
    ledSettings: { isEnabled: false },
    lightSettings: { isEnabled: false },
    mac: 'SMOKEMAC',
    marketName: 'USL Smoke',
    modelKey: 'sensor',
    motionSettings: { isEnabled: false },
    mountType: 'none',
    name: 'Hallway',
    smokeAlarmTriggeredAt: null,
    smokeStatus: makeSmokeStatus(),
    stats: {},
    tamperingDetectedAt: null,
    temperatureSettings: { isEnabled: false },
    troubleSilencedAt: null,
    type: 'USL-Smoke-US',
    ...overrides,
  };
}

// A sample UniFi Protect doorbell payload.
function makeDoorbellConfig(): Record<string, unknown> {

  return {

    channels: [],
    chimeDuration: 0,
    featureFlags: { hasChime: true, hasInfrared: false, hasLcdScreen: true, hasLedStatus: false, hasPackageCamera: false, hasSmartDetect: false,
      hasSpeaker: false, isDoorbell: true, smartDetectAudioTypes: [], smartDetectTypes: [] },
    firmwareVersion: '1.0.0',
    id: 'doorbell-id',
    isConnected: true,
    lcdMessage: null,
    mac: 'DOORBELLMAC',
    marketName: 'G4 Doorbell',
    modelKey: 'camera',
    name: 'Doorbell',
    recordingSettings: { mode: 'always' },
    smartDetectSettings: {},
    type: 'UVC G4 Doorbell',
  };
}

describe('ProtectDevice.writeDevice', () => {

  beforeEach(() => {

    enabledFeatures = new Set([ 'Device', 'Device.StatusLed.Switch' ]);
  });

  it('updates our view of the device when Protect accepts the update', async () => {

    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSensorConfig() as never, makeAccessory());
    const updated = { ...sensor.ufp, ledSettings: { isEnabled: false } };

    nvr.ufpApi.updateDevice.mockResolvedValueOnce(updated);

    await expect(sensor.writeDevice({ ledSettings: { isEnabled: false } }, 'failed')).resolves.toBe(updated);
    expect(sensor.ufp).toBe(updated);
    expect(nvr.ufpApi.updateDevice).toHaveBeenCalledWith(expect.objectContaining({ id: 'sensor-id' }), { ledSettings: { isEnabled: false } });
  });

  it('throws a HAP status error and leaves our view of the device unchanged when Protect rejects the update', async () => {

    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSensorConfig() as never, makeAccessory());
    const original = sensor.ufp;

    nvr.ufpApi.updateDevice.mockResolvedValueOnce(null);

    const error = await sensor.writeDevice({ ledSettings: { isEnabled: false } }, 'Unable to do %s.', 'it').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(hap.HapStatusError);
    expect((error as hap.HapStatusError).hapStatus).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(sensor.ufp).toBe(original);
    expect(nvr.platform.log.error).toHaveBeenCalledWith(expect.stringContaining('Unable to do it.'));
  });

  it('reports a failed HomeKit write as an error so HomeKit reverts, instead of reporting success', async () => {

    const nvr = makeNvr();
    const accessory = makeAccessory();
    const sensor = new ProtectSensor(nvr, makeSensorConfig() as never, accessory);
    const ledSwitch = accessory.getServiceById(hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

    expect(ledSwitch).toBeDefined();

    nvr.ufpApi.updateDevice.mockResolvedValueOnce(null);

    // HAP converts a thrown HapStatusError from a set handler into a failed write status for the controller.
    const status = await new Promise<unknown>((resolve) => {

      ledSwitch?.getCharacteristic(hap.Characteristic.On).handleSetRequest(false).then(() => resolve('ok'), (error: unknown) => resolve(error));
    });

    expect(status).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(sensor.statusLed).toBe(true);
    expect(await sensor.setStatusLed(false)).toBe(false);
  });
});

describe('Event subscriptions and cleanup', () => {

  beforeEach(() => {

    enabledFeatures = new Set([ 'Device', 'NVR.SystemInfo' ]);
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it('registers device listeners through subscribe() and removes them on cleanup()', () => {

    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSensorConfig() as never, makeAccessory());

    expect(nvr.events.listenerCount('updateEvent.sensor-id')).toBe(1);

    // Events are routed to the sensor.
    nvr.events.emit('updateEvent.sensor-id', { header: {}, payload: { motionDetectedAt: 1 } });
    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(sensor);

    sensor.cleanup();

    expect(nvr.events.listenerCount('updateEvent.sensor-id')).toBe(0);
  });

  it('removes the controller system information listener on cleanup()', () => {

    const nvr = makeNvr();
    const systemInfo = new ProtectNvrSystemInfo(nvr);

    expect(nvr.events.listenerCount('updateEvent.nvr-id')).toBe(1);

    systemInfo.cleanup();

    expect(nvr.events.listenerCount('updateEvent.nvr-id')).toBe(0);
  });

  it('clears the package camera flashlight heartbeat on cleanup()', () => {

    vi.useFakeTimers();

    const events = new EventEmitter();
    const heartbeat = vi.fn();
    const handler = vi.fn();
    const sensorsCleanup = vi.fn();
    const packageCamera = Object.assign(Object.create(ProtectCameraPackage.prototype) as object, {

      accessory: { removeController: vi.fn() },
      flashlightTimer: setInterval(heartbeat, 1000),
      listeners: { 'updateEvent.test': handler },
      livestream: { shutdown: vi.fn() },
      nvr: { events },
      sensors: { cleanup: sensorsCleanup },
    }) as unknown as ProtectCameraPackage;

    events.on('updateEvent.test', handler);
    packageCamera.cleanup();
    vi.advanceTimersByTime(5000);

    expect(heartbeat).not.toHaveBeenCalled();
    expect(events.listenerCount('updateEvent.test')).toBe(0);
    expect(sensorsCleanup).toHaveBeenCalled();
  });

  it('clears the doorbell authentication timer and cleans up the package camera on cleanup()', () => {

    vi.useFakeTimers();

    const expire = vi.fn();
    const packageCleanup = vi.fn();
    const doorbell = Object.assign(Object.create(ProtectDoorbell.prototype) as object, {

      accessory: { removeController: vi.fn() },
      contactAuthTimer: setTimeout(expire, 1000),
      listeners: {},
      livestream: { shutdown: vi.fn() },
      nvr: { events: new EventEmitter() },
      packageCamera: { cleanup: packageCleanup },
      sensors: { cleanup: vi.fn() },
    }) as unknown as ProtectDoorbell;

    doorbell.cleanup();
    vi.advanceTimersByTime(5000);

    expect(expire).not.toHaveBeenCalled();
    expect(packageCleanup).toHaveBeenCalled();
    expect(doorbell.packageCamera).toBeNull();
  });
});

describe('Table-driven sensor configuration', () => {

  beforeEach(() => {

    enabledFeatures = new Set(['Device']);
  });

  // Summarize the services on an accessory so we can compare them.
  const summarize = (accessory: PlatformAccessory): string[] =>
    accessory.services.filter(service => service.UUID !== hap.Service.AccessoryInformation.UUID)
      .map(service => [ service.constructor.name, service.subtype ?? '', service.displayName ].join('|')).sort();

  it('registers the same services, names, and subtypes as before', () => {

    const accessory = makeAccessory('Front Door');

    new ProtectSensor(makeNvr(), makeSensorConfig() as never, accessory);

    expect(summarize(accessory)).toEqual([

      'Battery||Front Door',
      'ContactSensor|' + ProtectReservedNames.CONTACT_SENSOR + '|Front Door',
      'ContactSensor|' + ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND + '|Front Door Alarm Sound',
      'HumiditySensor||Front Door',
      'LeakSensor|' + ProtectReservedNames.LEAKSENSOR_EXTERNAL + '|Front Door External Leak Sensor',
      'LeakSensor|' + ProtectReservedNames.LEAKSENSOR_INTERNAL + '|Front Door',
      'LightSensor||Front Door',
      'MotionSensor||Front Door',
      'TemperatureSensor||Front Door',
    ].sort());
  });

  it('initializes characteristic values and publishes the same MQTT topics as before', () => {

    const accessory = makeAccessory('Front Door');
    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSensorConfig() as never, accessory);

    expect(accessory.getService(hap.Service.LightSensor)?.getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel).value).toBe(0.0001);
    expect(accessory.getService(hap.Service.HumiditySensor)?.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).value).toBe(45);
    expect(accessory.getService(hap.Service.TemperatureSensor)?.getCharacteristic(hap.Characteristic.CurrentTemperature).value).toBe(21.5);
    expect(accessory.getServiceById(hap.Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL)
      ?.getCharacteristic(hap.Characteristic.LeakDetected).value).toBe(1);
    expect(accessory.getServiceById(hap.Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL)
      ?.getCharacteristic(hap.Characteristic.LeakDetected).value).toBe(0);

    expect(nvr.mqttPublished).toEqual([

      [ 'alarm', 'false' ], [ 'ambientlight', '0' ], [ 'contact', 'false' ], [ 'humidity', '45' ], [ 'leak-external', 'false' ], [ 'leak', 'true' ],
      [ 'temperature', '21.5' ],
    ]);
  });

  it('switches leak sensors to moisture contact sensors and skips leak MQTT publishing while offline', () => {

    enabledFeatures.add('Sensor.MoistureSensor');

    const accessory = makeAccessory('Front Door');
    const nvr = makeNvr();

    new ProtectSensor(nvr, { ...makeSensorConfig(), isConnected: false, mountType: 'leak' } as never, accessory);

    expect(accessory.getServiceById(hap.Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL)).toBeUndefined();
    expect(accessory.getServiceById(hap.Service.ContactSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL)?.displayName)
      .toBe('Front Door External Moisture Sensor');
    expect(accessory.getServiceById(hap.Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR)).toBeUndefined();
    expect(nvr.mqttPublished.map(([topic]) => topic)).not.toContain('leak');
  });
});

describe('Smoke detector configuration', () => {

  type FakeNvr = ReturnType<typeof makeNvr>;

  const SMOKE_TOPICS = [ 'carbonmonoxide', 'smoke', 'smokedetector' ];

  beforeEach(() => {

    enabledFeatures = new Set(['Device']);
  });

  // Summarize the services on an accessory so we can compare them.
  const summarize = (accessory: PlatformAccessory): string[] =>
    accessory.services.filter(service => service.UUID !== hap.Service.AccessoryInformation.UUID)
      .map(service => [ service.constructor.name, service.subtype ?? '', service.displayName ].join('|')).sort();

  // Deliver a realtime update the way the events handler does: merge it into our view of the device, then notify the device.
  const pushUpdate = (nvr: FakeNvr, sensor: ProtectSensor, payload: Record<string, unknown>): void => {

    sensor.ufp = { ...sensor.ufp, ...payload } as never;
    nvr.events.emit('updateEvent.sensor-id', { header: {}, payload });
  };

  // Count the log entries at a given level that contain the given text.
  const logged = (nvr: FakeNvr, level: 'info' | 'warn', text: string): number =>
    vi.mocked(nvr.platform.log[level]).mock.calls.filter(([message]) => String(message).includes(text)).length;

  // The messages published to MQTT on a given topic.
  const publishedTo = (nvr: FakeNvr, topic: string): string[] => nvr.mqttPublished.filter(([name]) => name === topic).map(([ , message ]) => message);

  // Answer an MQTT get request for a topic, or return undefined when the sensor has not registered that topic.
  const mqttGet = (nvr: FakeNvr, topic: string): string | undefined =>
    vi.mocked((nvr.mqtt as NonNullable<ProtectNvr['mqtt']>).subscribeGet).mock.calls.find(([ , name ]) => name === topic)?.[3]();

  // Read the characteristics of a smoke detector's two sensors.
  const read = (accessory: PlatformAccessory): { carbonMonoxide: unknown; carbonMonoxideFault: unknown; smoke: unknown; smokeFault: unknown } => ({

    carbonMonoxide: accessory.getService(hap.Service.CarbonMonoxideSensor)?.getCharacteristic(hap.Characteristic.CarbonMonoxideDetected).value,
    carbonMonoxideFault: accessory.getService(hap.Service.CarbonMonoxideSensor)?.getCharacteristic(hap.Characteristic.StatusFault).value,
    smoke: accessory.getService(hap.Service.SmokeSensor)?.getCharacteristic(hap.Characteristic.SmokeDetected).value,
    smokeFault: accessory.getService(hap.Service.SmokeSensor)?.getCharacteristic(hap.Characteristic.StatusFault).value,
  });

  it('adds a smoke sensor and a carbon monoxide sensor to a smoke detector', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);

    expect(summarize(accessory)).toEqual([ 'Battery||Hallway', 'CarbonMonoxideSensor||Hallway', 'SmokeSensor||Hallway' ]);
    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 0, smokeFault: 0 });
    expect(logged(nvr, 'info', 'Enabled sensors: carbon monoxide, smoke.')).toBe(1);
  });

  it('adds only the sensors for the alarm types a detector advertises', () => {

    const accessory = makeAccessory('Hallway');

    new ProtectSensor(makeNvr(), makeSmokeDetectorConfig({ featureFlags: { alarmTypes: ['smoke'] } }) as never, accessory);

    expect(summarize(accessory)).toEqual([ 'Battery||Hallway', 'SmokeSensor||Hallway' ]);
  });

  it.each([

    { config: { ...makeSensorConfig(), featureFlags: { alarmTypes: [ 'smoke', 'CO' ] }, smokeStatus: makeSmokeStatus({ coAlarm: true, smokeAlarm: true }) },
      label: 'a UP Sense that advertises the alarm sounds it listens for and reports a status block with both alarms set' },
    { config: makeSmokeDetectorConfig({ featureFlags: { alarmTypes: ['glassBreak'] }, marketName: 'USL Glass Break', type: 'USL-GlassBreak-US' }),
      label: 'another SuperLink sensor that reports a status block' },
    { config: makeSmokeDetectorConfig({ featureFlags: {} }), label: 'a smoke detector that advertises no alarm types' },
    { config: makeSmokeDetectorConfig({ featureFlags: undefined, smokeStatus: undefined }), label: 'a smoke detector on a controller that reports nothing about it' },
  ])('adds no smoke or carbon monoxide sensor to $label', ({ config }) => {

    const accessory = makeAccessory('Not A Detector');
    const nvr = makeNvr();

    new ProtectSensor(nvr, config as never, accessory);

    expect(accessory.getService(hap.Service.SmokeSensor)).toBeUndefined();
    expect(accessory.getService(hap.Service.CarbonMonoxideSensor)).toBeUndefined();
    expect(nvr.mqttPublished.filter(([topic]) => SMOKE_TOPICS.includes(topic))).toEqual([]);
  });

  it('reports a smoke alarm when it starts and when it clears, once each', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);

    expect(logged(nvr, 'info', 'Smoke')).toBe(0);
    expect(publishedTo(nvr, 'smoke')).toEqual(['false']);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ smokeAlarm: true }) });

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 1, smokeFault: 0 });
    expect(logged(nvr, 'info', 'Hallway: Smoke detected.')).toBe(1);
    expect(publishedTo(nvr, 'smoke').at(-1)).toBe('true');

    // An update that changes nothing about the alarm says nothing more about it.
    pushUpdate(nvr, sensor, { batteryStatus: { isLow: false, percentage: 99 } });

    expect(logged(nvr, 'info', 'Smoke detected.')).toBe(1);
    expect(read(accessory).smoke).toBe(1);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus() });

    expect(read(accessory).smoke).toBe(0);
    expect(logged(nvr, 'info', 'Hallway: Smoke no longer detected.')).toBe(1);
    expect(publishedTo(nvr, 'smoke').at(-1)).toBe('false');
  });

  it('reports a carbon monoxide alarm on the carbon monoxide sensor alone', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coAlarm: true }) });

    expect(read(accessory)).toEqual({ carbonMonoxide: 1, carbonMonoxideFault: 0, smoke: 0, smokeFault: 0 });
    expect(logged(nvr, 'info', 'Hallway: Carbon monoxide detected.')).toBe(1);
    expect(logged(nvr, 'info', 'Smoke detected.')).toBe(0);
    expect(publishedTo(nvr, 'carbonmonoxide').at(-1)).toBe('true');
    expect(publishedTo(nvr, 'smoke').at(-1)).toBe('false');
  });

  it('notifies HomeKit of each alarm on its own sensor, which is what HomeKit alerts on', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);
    const hapAccessory = accessory as unknown as hap.Accessory;
    let notified: [string, string, unknown][] = [];

    // Homebridge publishes our accessories behind its bridge, and a bridged accessory hands every characteristic change to that bridge. As HAP does, we only
    // count the ones that changed a value: those are what HomeKit is sent.
    new hap.Bridge('Bridge', hap.uuid.generate('Bridge')).addBridgedAccessory(hapAccessory);

    hapAccessory.on(hap.AccessoryEventTypes.SERVICE_CHARACTERISTIC_CHANGE, (change) => {

      if(change.oldValue !== change.newValue) {

        notified.push([ change.service.constructor.name, change.characteristic.constructor.name, change.newValue ]);
      }
    });

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ smokeAlarm: true }) });

    expect(notified).toEqual([[ 'SmokeSensor', 'SmokeDetected', hap.Characteristic.SmokeDetected.SMOKE_DETECTED ]]);

    notified = [];
    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coAlarm: true, smokeAlarm: true }) });

    expect(notified).toEqual([[ 'CarbonMonoxideSensor', 'CarbonMonoxideDetected', hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL ]]);

    // An update that changes neither alarm sends HomeKit nothing.
    notified = [];
    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coAlarm: true, coValue: 80, smokeAlarm: true }) });

    expect(notified).toEqual([]);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus() });

    expect(notified).toHaveLength(2);
    expect(notified).toEqual(expect.arrayContaining([

      [ 'CarbonMonoxideSensor', 'CarbonMonoxideDetected', hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL ],
      [ 'SmokeSensor', 'SmokeDetected', hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED ],
    ]));
  });

  it('announces an alarm that is already sounding at startup', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSmokeDetectorConfig({ smokeStatus: makeSmokeStatus({ smokeAlarm: true }) }) as never, accessory);

    expect(read(accessory).smoke).toBe(1);
    expect(logged(nvr, 'info', 'Smoke detected.')).toBe(1);
  });

  it('faults each sensor for its own flags, and announces a fault each time the reasons change', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig({ smokeStatus: makeSmokeStatus({ cleanSmokeSensor: true }) }) as never, accessory);

    // A smoke chamber that needs cleaning faults the smoke sensor and leaves the carbon monoxide sensor alone.
    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 0, smokeFault: 1 });
    expect(logged(nvr, 'warn', 'Hallway: The smoke sensor is reporting a fault: needs cleaning.')).toBe(1);
    expect(logged(nvr, 'warn', 'The carbon monoxide sensor')).toBe(0);

    // The end of the detector's life faults both sensors, and the smoke sensor says so even though it was already faulted.
    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ cleanSmokeSensor: true, endOfLife: true }) });

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 1, smoke: 0, smokeFault: 1 });
    expect(logged(nvr, 'warn', 'The smoke sensor is reporting a fault: end of life, needs cleaning.')).toBe(1);
    expect(logged(nvr, 'warn', 'The carbon monoxide sensor is reporting a fault: end of life.')).toBe(1);

    // An update that changes no fault flag warns about nothing.
    pushUpdate(nvr, sensor, { batteryStatus: { isLow: false, percentage: 99 } });

    expect(logged(nvr, 'warn', 'is reporting a fault')).toBe(3);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus() });

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 0, smokeFault: 0 });
    expect(logged(nvr, 'info', 'The smoke sensor is no longer reporting a fault.')).toBe(1);
    expect(logged(nvr, 'info', 'The carbon monoxide sensor is no longer reporting a fault.')).toBe(1);
  });

  it('faults only the carbon monoxide sensor for a carbon monoxide sensor fault', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSmokeDetectorConfig({ smokeStatus: makeSmokeStatus({ coSensorFault: true }) }) as never, accessory);

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 1, smoke: 0, smokeFault: 0 });
    expect(logged(nvr, 'warn', 'The carbon monoxide sensor is reporting a fault: sensor fault.')).toBe(1);
  });

  it('holds the last reported alarm and fault while the detector reports no status', async () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig({ smokeStatus: makeSmokeStatus({ coSensorFault: true, smokeAlarm: true }) }) as never,
      accessory);
    const publishedBefore = nvr.mqttPublished.filter(([topic]) => SMOKE_TOPICS.includes(topic)).length;

    pushUpdate(nvr, sensor, { smokeStatus: null });

    // Nothing is cleared, announced, or published on the strength of a status the detector never sent.
    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 1, smoke: 1, smokeFault: 0 });
    expect(logged(nvr, 'info', 'Smoke no longer detected.')).toBe(0);
    expect(logged(nvr, 'info', 'no longer reporting a fault')).toBe(0);
    expect(nvr.mqttPublished.filter(([topic]) => SMOKE_TOPICS.includes(topic))).toHaveLength(publishedBefore);

    // HomeKit and MQTT reads answer with the held state rather than an all-clear.
    await expect(accessory.getService(hap.Service.SmokeSensor)?.getCharacteristic(hap.Characteristic.SmokeDetected).handleGetRequest()).resolves.toBe(1);
    await expect(accessory.getService(hap.Service.CarbonMonoxideSensor)?.getCharacteristic(hap.Characteristic.StatusFault).handleGetRequest()).resolves.toBe(1);
    expect(mqttGet(nvr, 'smoke')).toBe('true');
    expect(mqttGet(nvr, 'smokedetector')).toBe('null');

    // Once the detector reports again, we follow it.
    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus() });

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 0, smokeFault: 0 });
    expect(logged(nvr, 'info', 'Smoke no longer detected.')).toBe(1);
  });

  it('keeps an alarm restored from the accessory cache when the detector has not reported since a restart', async () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();

    // Homebridge restores the accessory, alarm and all, before the detector has said anything.
    accessory.addService(new hap.Service.SmokeSensor('Hallway')).updateCharacteristic(hap.Characteristic.SmokeDetected, 1);

    new ProtectSensor(nvr, makeSmokeDetectorConfig({ smokeStatus: null }) as never, accessory);

    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 1, smokeFault: 0 });
    await expect(accessory.getService(hap.Service.SmokeSensor)?.getCharacteristic(hap.Characteristic.SmokeDetected).handleGetRequest()).resolves.toBe(1);
    expect(nvr.mqttPublished.filter(([topic]) => SMOKE_TOPICS.includes(topic))).toEqual([]);
    expect(logged(nvr, 'info', 'Smoke')).toBe(0);
  });

  it('removes a sensor when the detector stops advertising its alarm type', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);

    pushUpdate(nvr, sensor, { featureFlags: { alarmTypes: ['smoke'] } });

    expect(summarize(accessory)).toEqual([ 'Battery||Hallway', 'SmokeSensor||Hallway' ]);
    expect(logged(nvr, 'info', 'Enabled sensor: smoke.')).toBe(1);
  });

  it('publishes the full detector status to MQTT, with exactly the documented members', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSmokeDetectorConfig({

      alarmSilencedAt: 3,
      coAlarmTriggeredAt: 2,
      smokeAlarmTriggeredAt: 1,
      smokeStatus: makeSmokeStatus({ batteryVoltage: 3012, coValue: 4, smokeAlarm: true, smokeValue: 3410, someFutureMember: true }),
      troubleSilencedAt: 4,
    }) as never, accessory);

    const published = publishedTo(nvr, 'smokedetector');

    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0] ?? '')).toEqual({

      alarmSilenced: false, alarmSilencedAt: 3, batteryLow: false, batteryVoltage: 3012, cleanSmokeSensor: false, coAlarm: false, coAlarmTriggeredAt: 2,
      coSensorFault: false, coValue: 4, enabled: true, endOfLife: false, ready: true, smokeAlarm: true, smokeAlarmTriggeredAt: 1, smokeSensorFault: false,
      smokeValue: 3410, testing: false, troubleHushed: false, troubleSilencedAt: 4, wasMounted: true,
    });
    expect(mqttGet(nvr, 'smokedetector')).toBe(published[0]);
  });

  it('reports timestamps the controller has never set as null in the detector status', () => {

    const nvr = makeNvr();

    new ProtectSensor(nvr, makeSmokeDetectorConfig({ alarmSilencedAt: undefined, coAlarmTriggeredAt: undefined, smokeAlarmTriggeredAt: undefined,
      troubleSilencedAt: undefined }) as never, makeAccessory('Hallway'));

    expect(JSON.parse(publishedTo(nvr, 'smokedetector')[0] ?? '')).toMatchObject({ alarmSilencedAt: null, coAlarmTriggeredAt: null, smokeAlarmTriggeredAt: null,
      troubleSilencedAt: null });
  });

  it('announces when a self-test starts and ends without reporting an alarm', () => {

    const accessory = makeAccessory('Hallway');
    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, accessory);

    expect(logged(nvr, 'info', 'self-test')).toBe(0);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coValue: 1, smokeValue: 3410, testing: true }) });

    expect(logged(nvr, 'info', "Hallway: The smoke detector's self-test has started.")).toBe(1);
    expect(read(accessory)).toEqual({ carbonMonoxide: 0, carbonMonoxideFault: 0, smoke: 0, smokeFault: 0 });

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coValue: 1, smokeValue: 3400, testing: true }) });

    expect(logged(nvr, 'info', 'self-test')).toBe(1);

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus() });

    expect(logged(nvr, 'info', "Hallway: The smoke detector's self-test has ended.")).toBe(1);
  });

  it('answers MQTT get requests with the current alarm states', () => {

    const nvr = makeNvr();
    const sensor = new ProtectSensor(nvr, makeSmokeDetectorConfig() as never, makeAccessory('Hallway'));

    expect(mqttGet(nvr, 'smoke')).toBe('false');
    expect(mqttGet(nvr, 'carbonmonoxide')).toBe('false');

    pushUpdate(nvr, sensor, { smokeStatus: makeSmokeStatus({ coAlarm: true, smokeAlarm: true }) });

    expect(mqttGet(nvr, 'smoke')).toBe('true');
    expect(mqttGet(nvr, 'carbonmonoxide')).toBe('true');
  });

  it('registers the smoke detector MQTT topics only on smoke detectors', () => {

    const nvr = makeNvr();

    new ProtectSensor(nvr, { ...makeSensorConfig(), featureFlags: { alarmTypes: [ 'smoke', 'CO' ] }, smokeStatus: makeSmokeStatus() } as never,
      makeAccessory('Front Door'));

    for(const topic of SMOKE_TOPICS) {

      expect(mqttGet(nvr, topic)).toBeUndefined();
    }
  });
});

describe('ProtectDoorbell delegates', () => {

  beforeEach(() => {

    enabledFeatures = new Set([ 'Device', 'Doorbell.Messages', 'Doorbell.PhysicalChime' ]);
  });

  it('keeps its delegates after construction and reverts failed physical chime writes', async () => {

    const nvr = makeNvr();
    const accessory = makeAccessory('Doorbell');
    const doorbell = new ProtectDoorbell(nvr, makeDoorbellConfig() as never, accessory);

    // configureDevice() runs inside our parent's constructor. Make sure class field initialization hasn't wiped out what it set up.
    expect(doorbell.chimes.chimeDigitalDuration).toBe(1000);
    expect(doorbell.lcdMessages.defaultMessageDuration).toBe(60000);
    expect(nvr.events.listenerCount('updateEvent.chime')).toBe(1);

    const digital = accessory.getServiceById(hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL);
    const original = doorbell.ufp;

    expect(digital).toBeDefined();

    nvr.ufpApi.updateDevice.mockResolvedValueOnce(null);

    await expect(digital?.getCharacteristic(hap.Characteristic.On).handleSetRequest(true)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(doorbell.ufp).toBe(original);
    expect(nvr.ufpApi.updateDevice).toHaveBeenCalledWith(original, { chimeDuration: 1000 });

    doorbell.cleanup();

    expect(nvr.events.listenerCount('updateEvent.chime')).toBe(0);
  });
});
