/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-sensor-smoke.ts: Smoke and carbon monoxide detection policy for UniFi Protect sensors.
 */
import type { ProtectSensorSmokeStatus } from '../unifi/index.js';

// Every decision we make about a smoke detector lives here: whether a sensor is detector hardware at all, which alarms it detects, whether an alarm is
// sounding, and which of the detector's fault flags stand against which HomeKit service. These are pure functions, so the service gates, the characteristic
// handlers, the logging, and MQTT all agree on what "detected" and "faulted" mean.

// The alarm types a UniFi Protect sensor advertises in featureFlags.alarmTypes, as they appear on the wire.
export const SMOKE_ALARM_TYPES = { carbonMonoxide: 'CO', smoke: 'smoke' } as const;

// One of the alarm types a smoke detector can report.
export type SmokeAlarmType = (typeof SMOKE_ALARM_TYPES)[keyof typeof SMOKE_ALARM_TYPES];

// A fault flag that a smoke detector can report.
export type SmokeFaultReason = 'cleanSmokeSensor' | 'coSensorFault' | 'endOfLife' | 'smokeSensorFault';

// Which flags fault which service, in the order we report them. Both sensors share the detector reaching the end of its life. Beyond that, each answers for its
// own sensor fault, and the smoke sensor also answers for a smoke chamber that needs cleaning.
const CARBON_MONOXIDE_FAULTS: readonly SmokeFaultReason[] = [ 'coSensorFault', 'endOfLife' ];
const SMOKE_FAULTS: readonly SmokeFaultReason[] = [ 'smokeSensorFault', 'endOfLife', 'cleanSmokeSensor' ];

// Decide whether a sensor is smoke detector hardware, based on its model. Nothing else on the wire can tell us: a UP Sense listens for the sound of smoke and
// carbon monoxide alarms, so it advertises the same alarm types a detector does and reports a status block alongside them. We match the model type by its
// family prefix so that every regional variant is recognized.
export function smokeDetectorHardware(config: { readonly marketName?: string; readonly type?: string }): boolean {

  return (config.marketName === 'USL Smoke') || (config.type?.startsWith('USL-Smoke-') ?? false);
}

// Decide whether a detector advertises a given alarm type. A detector that advertises nothing detects nothing.
export function smokeAlarmCapable(alarmTypes: readonly string[] | undefined, alarmType: SmokeAlarmType): boolean {

  return alarmTypes?.includes(alarmType) ?? false;
}

// Return true when the detector is reporting a carbon monoxide alarm.
export function carbonMonoxideDetected(status: ProtectSensorSmokeStatus): boolean {

  return status.coAlarm;
}

// Return true when the detector is reporting a smoke alarm.
export function smokeDetected(status: ProtectSensorSmokeStatus): boolean {

  return status.smokeAlarm;
}

// Return the fault flags that stand against the carbon monoxide sensor. The list is empty when nothing is wrong.
export function carbonMonoxideFaultReasons(status: ProtectSensorSmokeStatus): SmokeFaultReason[] {

  return CARBON_MONOXIDE_FAULTS.filter(reason => status[reason]);
}

// Return the fault flags that stand against the smoke sensor. The list is empty when nothing is wrong.
export function smokeFaultReasons(status: ProtectSensorSmokeStatus): SmokeFaultReason[] {

  return SMOKE_FAULTS.filter(reason => status[reason]);
}
