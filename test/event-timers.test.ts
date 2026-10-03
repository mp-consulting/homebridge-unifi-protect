/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * event-timers.test.ts: Tests for motion, smart detection, occupancy, and doorbell event timers in protect-events.ts.
 *
 * These tests drive the real ProtectEvents class with a fake NVR and accessories built on the real HAP, using fake timers to verify that HomeKit state is set
 * when an event arrives, reset once the configured duration elapses, and re-armed (rather than stacked) when events repeat.
 */
import * as hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectCamera, ProtectDevice } from '../src/devices/index.js';
import { EventEmitter } from 'node:events';
import type { ProtectNvr } from '../src/protect-nvr.js';
import { ProtectEvents } from '../src/protect-events.js';
import { ProtectReservedNames } from '../src/protect-types.js';

const MOTION_DURATION = 10;
const NOT_OCCUPIED = hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
const OCCUPIED = hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
const OCCUPANCY_DURATION = 300;

interface FakeHints {

  logDoorbell: boolean;
  logMotion: boolean;
  motionDuration: number;
  occupancyDuration: number;
  smartDetect: boolean;
  smartOccupancy: string[];
}

interface Harness {

  device: ProtectDevice & ProtectCamera;
  events: ProtectEvents;
  published: [string, string][];
}

// Build a fake device with a real HAP accessory carrying the services the event handlers look for.
function makeDevice(id: string, hints: Partial<FakeHints> = {}, context: Record<string, unknown> = {}): ProtectDevice & ProtectCamera {

  const accessory = new hap.Accessory('Test ' + id, hap.uuid.generate(id));

  accessory.addService(hap.Service.MotionSensor);
  accessory.addService(hap.Service.OccupancySensor);
  accessory.addService(hap.Service.Doorbell);
  accessory.addService(hap.Service.Switch, 'Motion Trigger', ProtectReservedNames.SWITCH_MOTION_TRIGGER);
  accessory.addService(hap.Service.Switch, 'Doorbell Trigger', ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);
  accessory.addService(hap.Service.ContactSensor, 'Person', ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.person');
  accessory.addService(hap.Service.ContactSensor, 'Vehicle', ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.vehicle');

  return {

    accessory,
    context: { detectMotion: true, doorbellMuted: false, ...context },
    hints: { logDoorbell: false, logMotion: false, motionDuration: MOTION_DURATION, occupancyDuration: OCCUPANCY_DURATION, smartDetect: false,
      smartOccupancy: [], ...hints },
    id,
    isRinging: false,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ufp: { mac: id.toUpperCase() },
  } as unknown as ProtectDevice & ProtectCamera;
}

// Build a ProtectEvents instance around a fake NVR.
function makeHarness(hints: Partial<FakeHints> = {}, context: Record<string, unknown> = {}, ringDelay = 0): Harness {

  const published: [string, string][] = [];
  const device = makeDevice('aabbccddeeff', hints, context);

  const nvr = {

    getDeviceById: (id: string): ProtectDevice | null => (id === device.id) ? device : null,
    hasFeature: (): boolean => false,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    mqtt: { publish: (_mac: string, topic: string, message: string): void => void published.push([topic, message]) },
    platform: { api: { hap }, config: { ringDelay } },
    ufp: { mac: 'NVRMAC' },
    ufpApi: new EventEmitter(),
  } as unknown as ProtectNvr;

  return { device, events: new ProtectEvents(nvr), published };
}

// Convenience accessors for the HomeKit state we care about.
const motionDetected = (device: ProtectDevice): unknown => device.accessory.getService(hap.Service.MotionSensor)
  ?.getCharacteristic(hap.Characteristic.MotionDetected).value;

const occupancyDetected = (device: ProtectDevice): unknown => device.accessory.getService(hap.Service.OccupancySensor)
  ?.getCharacteristic(hap.Characteristic.OccupancyDetected).value;

const smartContact = (device: ProtectDevice, type: string): unknown => device.accessory
  .getServiceById(hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + '.' + type)
  ?.getCharacteristic(hap.Characteristic.ContactSensorState).value;

const switchOn = (device: ProtectDevice, subtype: string): unknown => device.accessory.getServiceById(hap.Service.Switch, subtype)
  ?.getCharacteristic(hap.Characteristic.On).value;

describe('ProtectEvents timers', () => {

  beforeEach(() => {

    vi.useFakeTimers();
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  describe('motion', () => {

    it('sets motion and the motion trigger, then resets both after the motion duration', () => {

      const { device, events, published } = makeHarness();

      events.motionEventHandler(device);

      expect(motionDetected(device)).toBe(true);
      expect(switchOn(device, ProtectReservedNames.SWITCH_MOTION_TRIGGER)).toBe(true);
      expect(published).toContainEqual(['motion', 'true']);

      vi.advanceTimersByTime((MOTION_DURATION * 1000) - 1);
      expect(motionDetected(device)).toBe(true);

      vi.advanceTimersByTime(1);
      expect(motionDetected(device)).toBe(false);
      expect(switchOn(device, ProtectReservedNames.SWITCH_MOTION_TRIGGER)).toBe(false);
      expect(published).toContainEqual(['motion', 'false']);
    });

    it('re-arms the reset timer on repeated motion instead of stacking timers', () => {

      const { device, events, published } = makeHarness();

      events.motionEventHandler(device);
      vi.advanceTimersByTime(8000);
      events.motionEventHandler(device);

      // The original timer would have fired here - it must have been replaced.
      vi.advanceTimersByTime(4000);
      expect(motionDetected(device)).toBe(true);

      vi.advanceTimersByTime(6000);
      expect(motionDetected(device)).toBe(false);

      // We only announce the start and the end of the motion event once each.
      expect(published.filter(([topic]) => topic === 'motion')).toEqual([[ 'motion', 'true' ], [ 'motion', 'false' ]]);
    });

    it('ignores motion when motion detection is disabled for the device', () => {

      const { device, events, published } = makeHarness({}, { detectMotion: false });
      const timers = vi.getTimerCount();

      events.motionEventHandler(device);

      expect(motionDetected(device)).toBe(false);
      expect(published).toEqual([]);
      expect(vi.getTimerCount()).toBe(timers);
    });
  });

  describe('smart detection', () => {

    it('uses an independent timer per object type', () => {

      const { device, events } = makeHarness({ smartDetect: true });
      const detected = hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

      events.motionEventHandler(device, ['person']);
      vi.advanceTimersByTime(5000);
      events.motionEventHandler(device, ['vehicle']);

      expect(smartContact(device, 'person')).toBe(detected);
      expect(smartContact(device, 'vehicle')).toBe(detected);

      // The person timer expires first, leaving the vehicle sensor untouched.
      vi.advanceTimersByTime(5000);
      expect(smartContact(device, 'person')).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
      expect(smartContact(device, 'vehicle')).toBe(detected);

      vi.advanceTimersByTime(5000);
      expect(smartContact(device, 'vehicle')).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    });

    it('does not trigger smart sensors when smart detection is disabled', () => {

      const { device, events } = makeHarness({ smartDetect: false });

      events.motionEventHandler(device, ['person']);

      expect(smartContact(device, 'person')).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    });
  });

  describe('occupancy', () => {

    it('uses the occupancy duration rather than the motion duration', () => {

      const { device, events } = makeHarness();

      events.motionEventHandler(device);

      vi.advanceTimersByTime(MOTION_DURATION * 1000);
      expect(motionDetected(device)).toBe(false);
      expect(occupancyDetected(device)).toBe(OCCUPIED);

      vi.advanceTimersByTime((OCCUPANCY_DURATION - MOTION_DURATION) * 1000);
      expect(occupancyDetected(device)).toBe(NOT_OCCUPIED);
    });

    it('only triggers on configured smart occupancy objects when smart detection is enabled', () => {

      const { device, events } = makeHarness({ smartDetect: true, smartOccupancy: ['person'] });

      events.motionEventHandler(device, ['vehicle']);
      expect(occupancyDetected(device)).toBe(NOT_OCCUPIED);

      events.motionEventHandler(device, ['person']);
      expect(occupancyDetected(device)).toBe(OCCUPIED);
    });

    it('announces occupancy once while the space remains occupied', () => {

      const { device, events, published } = makeHarness();

      events.motionEventHandler(device);
      vi.advanceTimersByTime(60 * 1000);
      events.motionEventHandler(device);

      expect(published.filter(entry => entry[0] === 'occupancy')).toEqual([[ 'occupancy', 'true' ]]);
    });
  });

  describe('doorbell', () => {

    it('turns the doorbell trigger on while ringing and publishes the ring', () => {

      const { device, events, published } = makeHarness();

      events.doorbellEventHandler(device, Date.now());

      expect(device.isRinging).toBe(true);
      expect(switchOn(device, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)).toBe(true);
      expect(published).toContainEqual(['doorbell', 'true']);
    });

    it('debounces rings while the ring delay is active', () => {

      const { device, events, published } = makeHarness({}, {}, 5);

      events.doorbellEventHandler(device, Date.now());
      events.doorbellEventHandler(device, Date.now());

      expect(published.filter(entry => entry[0] === 'doorbell' && entry[1] === 'true')).toHaveLength(1);

      // Once the ring delay has passed, a new ring is accepted again.
      vi.advanceTimersByTime(5000);
      events.doorbellEventHandler(device, Date.now());

      expect(published.filter(entry => entry[0] === 'doorbell' && entry[1] === 'true')).toHaveLength(2);
    });
  });

  describe('state tracking', () => {

    it('does not retain state for event packets, only for devices', () => {

      const { events } = makeHarness();
      const emit = (modelKey: string, id: string): boolean => events.emit('updateEvent', { header: { action: 'update', id, modelKey }, payload: {} });

      for(let i = 0; i < 100; i++) {

        emit('event', 'event' + i.toString());
      }

      emit('camera', 'newcamera');

      const state = (events as unknown as { ufpDeviceState: Record<string, unknown> }).ufpDeviceState;

      expect(Object.keys(state)).toEqual(['newcamera']);
    });
  });
});
