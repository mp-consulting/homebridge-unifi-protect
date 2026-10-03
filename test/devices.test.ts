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
