/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * sensor-smoke.test.ts: Tests for the smoke and carbon monoxide detection policy (protect-sensor-smoke.ts).
 *
 * Covers which sensors are smoke detector hardware, which alarm types a detector advertises, when an alarm is sounding, and which fault flags stand against
 * which HomeKit service.
 */
import { SMOKE_ALARM_TYPES, carbonMonoxideDetected, carbonMonoxideFaultReasons, smokeAlarmCapable, smokeDetected, smokeDetectorHardware,
  smokeFaultReasons } from '../src/devices/protect-sensor-smoke.js';
import { describe, expect, it } from 'vitest';
import type { ProtectSensorSmokeStatus } from '../src/unifi/index.js';

// The status block a healthy smoke detector reports at rest. Tests name only the members they move.
function makeSmokeStatus(overrides: Partial<ProtectSensorSmokeStatus> = {}): ProtectSensorSmokeStatus {

  return { alarmSilenced: false, batteryLow: false, batteryVoltage: 0, cleanSmokeSensor: false, coAlarm: false, coSensorFault: false, coValue: 0, enabled: true,
    endOfLife: false, ready: true, smokeAlarm: false, smokeSensorFault: false, smokeValue: 0, testing: false, troubleHushed: false, wasMounted: true,
    ...overrides };
}

describe('Smoke detector hardware', () => {

  it.each([

    { config: { marketName: 'USL Smoke', type: 'USL-Smoke-US' }, expected: true, label: 'the detector as the controller reports it' },
    { config: { marketName: 'Some Other Name', type: 'USL-Smoke-EU' }, expected: true, label: "another region's type under the family prefix" },
    { config: { marketName: 'USL Smoke' }, expected: true, label: 'the market name alone' },
    { config: { marketName: 'UP Sense', type: 'UFP-SENSE' }, expected: false, label: 'a UP Sense, which only listens for alarm sounds' },
    { config: { marketName: 'USL Glass Break', type: 'USL-GlassBreak-US' }, expected: false, label: 'another SuperLink sensor' },
    { config: { type: 'USL-SmokeExtra-US' }, expected: false, label: 'a type sharing the stem without the family hyphen' },
    { config: {}, expected: false, label: 'a record with neither field' },
  ])('$label is detector hardware: $expected', ({ config, expected }) => {

    expect(smokeDetectorHardware(config)).toBe(expected);
  });
});

describe('Advertised alarm types', () => {

  it('reports nothing for a sensor that advertises no alarm types', () => {

    expect(smokeAlarmCapable(undefined, SMOKE_ALARM_TYPES.smoke)).toBe(false);
    expect(smokeAlarmCapable([], SMOKE_ALARM_TYPES.carbonMonoxide)).toBe(false);
  });

  it('reports only the alarm types that are advertised', () => {

    expect(smokeAlarmCapable(['smoke'], SMOKE_ALARM_TYPES.smoke)).toBe(true);
    expect(smokeAlarmCapable(['smoke'], SMOKE_ALARM_TYPES.carbonMonoxide)).toBe(false);
    expect(smokeAlarmCapable([ 'smoke', 'CO' ], SMOKE_ALARM_TYPES.carbonMonoxide)).toBe(true);
    expect(smokeAlarmCapable(['glassBreak'], SMOKE_ALARM_TYPES.smoke)).toBe(false);
  });
});

describe('Alarm detection', () => {

  it('reports no alarm for a detector at rest', () => {

    expect(smokeDetected(makeSmokeStatus())).toBe(false);
    expect(carbonMonoxideDetected(makeSmokeStatus())).toBe(false);
  });

  it('keeps the smoke and carbon monoxide alarms apart', () => {

    expect(smokeDetected(makeSmokeStatus({ smokeAlarm: true }))).toBe(true);
    expect(carbonMonoxideDetected(makeSmokeStatus({ smokeAlarm: true }))).toBe(false);
    expect(carbonMonoxideDetected(makeSmokeStatus({ coAlarm: true }))).toBe(true);
    expect(smokeDetected(makeSmokeStatus({ coAlarm: true }))).toBe(false);
  });

  it('does not treat a self-test, with its raised raw readings, as an alarm', () => {

    const selfTest = makeSmokeStatus({ coValue: 1, smokeValue: 3410, testing: true });

    expect(smokeDetected(selfTest)).toBe(false);
    expect(carbonMonoxideDetected(selfTest)).toBe(false);
  });
});

describe('Fault flags', () => {

  it.each([

    { carbonMonoxide: [], flags: {}, label: 'a healthy detector', smoke: [] },
    { carbonMonoxide: [], flags: { cleanSmokeSensor: true }, label: 'a smoke chamber that needs cleaning', smoke: ['cleanSmokeSensor'] },
    { carbonMonoxide: [], flags: { smokeSensorFault: true }, label: 'a smoke sensor fault', smoke: ['smokeSensorFault'] },
    { carbonMonoxide: ['coSensorFault'], flags: { coSensorFault: true }, label: 'a carbon monoxide sensor fault', smoke: [] },
    { carbonMonoxide: ['endOfLife'], flags: { endOfLife: true }, label: 'a detector at end of life', smoke: ['endOfLife'] },
    { carbonMonoxide: [ 'coSensorFault', 'endOfLife' ], flags: { cleanSmokeSensor: true, coSensorFault: true, endOfLife: true, smokeSensorFault: true },
      label: 'every fault at once', smoke: [ 'smokeSensorFault', 'endOfLife', 'cleanSmokeSensor' ] },
    { carbonMonoxide: [], flags: { alarmSilenced: true, batteryLow: true, troubleHushed: true }, label: 'conditions that are not sensor faults', smoke: [] },
  ])('$label faults the smoke sensor with $smoke and the carbon monoxide sensor with $carbonMonoxide', ({ carbonMonoxide, flags, smoke }) => {

    const status = makeSmokeStatus(flags);

    expect(smokeFaultReasons(status)).toEqual(smoke);
    expect(carbonMonoxideFaultReasons(status)).toEqual(carbonMonoxide);
  });
});
