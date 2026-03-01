/* Copyright(C) 2020-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-types.test.ts: Unit tests for types and enums in protect-types.ts.
 */
import { ProtectDeviceCategories, ProtectReservedNames, toCamelCase } from '../src/protect-types.js';

describe('ProtectDeviceCategories', () => {

  it('contains the expected device types', () => {

    expect(ProtectDeviceCategories).toContain('camera');
    expect(ProtectDeviceCategories).toContain('chime');
    expect(ProtectDeviceCategories).toContain('light');
    expect(ProtectDeviceCategories).toContain('sensor');
    expect(ProtectDeviceCategories).toContain('viewer');
  });

  it('contains exactly five device categories', () => {

    expect(ProtectDeviceCategories).toHaveLength(5);
  });
});

describe('ProtectReservedNames', () => {

  it('has unique enum values (no duplicates)', () => {

    const values = Object.values(ProtectReservedNames);
    const uniqueValues = new Set(values);

    expect(uniqueValues.size).toBe(values.length);
  });

  it('contains the expected reserved name entries', () => {

    expect(ProtectReservedNames.CONTACT_AUTHSENSOR).toBe('ContactAuthSensor');
    expect(ProtectReservedNames.SWITCH_HKSV_RECORDING).toBe('HKSVRecordingSwitch');
    expect(ProtectReservedNames.LOCK_ACCESS).toBe('Access');
  });
});

describe('toCamelCase re-export', () => {

  it('is re-exported from protect-types and works correctly', () => {

    expect(typeof toCamelCase).toBe('function');
    expect(toCamelCase('hello world')).toBe('Hello World');
  });
});
