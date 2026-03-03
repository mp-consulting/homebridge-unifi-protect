/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * sensor-logic.test.ts: Tests for sensor-related algorithms from protect-camera-sensors.ts.
 *
 * Covers license plate feature value parsing and ambient light lux clamping.
 */
import { HOMEKIT_AMBIENT_LIGHT_MINIMUM } from '../src/settings.js';

// Reproduction of the license plate parsing from configureSmartSensors().
function parseLicensePlates(featureValue: string | undefined | null): string[] {

  return featureValue?.split('-').filter(x => x.length).map(x => x.toUpperCase()) ?? [];
}

// Reproduction of the ambient light lux clamping from configureAmbientLight().
function clampLux(lux: number): number {

  lux ||= HOMEKIT_AMBIENT_LIGHT_MINIMUM;

  return lux;
}

describe('License Plate Parsing', () => {

  it('parses a single plate', () => {

    expect(parseLicensePlates('ABC123')).toEqual(['ABC123']);
  });

  it('parses multiple plates separated by hyphens', () => {

    expect(parseLicensePlates('ABC123-DEF456-GHI789')).toEqual(['ABC123', 'DEF456', 'GHI789']);
  });

  it('uppercases lowercase input', () => {

    expect(parseLicensePlates('abc123-def456')).toEqual(['ABC123', 'DEF456']);
  });

  it('filters out empty segments from trailing separator', () => {

    expect(parseLicensePlates('ABC-DEF-')).toEqual(['ABC', 'DEF']);
  });

  it('filters out empty segments from leading separator', () => {

    expect(parseLicensePlates('-ABC-DEF')).toEqual(['ABC', 'DEF']);
  });

  it('filters out empty segments from consecutive separators', () => {

    expect(parseLicensePlates('ABC--DEF')).toEqual(['ABC', 'DEF']);
  });

  it('returns empty array for empty string', () => {

    expect(parseLicensePlates('')).toEqual([]);
  });

  it('returns empty array for undefined', () => {

    expect(parseLicensePlates(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {

    expect(parseLicensePlates(null)).toEqual([]);
  });

  it('preserves already uppercase input', () => {

    expect(parseLicensePlates('PLATE1-PLATE2')).toEqual(['PLATE1', 'PLATE2']);
  });

  it('handles mixed case', () => {

    expect(parseLicensePlates('AbC123-dEf456')).toEqual(['ABC123', 'DEF456']);
  });
});

describe('Ambient Light Lux Clamping', () => {

  it('passes through positive lux values unchanged', () => {

    expect(clampLux(100)).toBe(100);
    expect(clampLux(0.5)).toBe(0.5);
    expect(clampLux(50000)).toBe(50000);
  });

  it('clamps 0 to the HomeKit minimum', () => {

    expect(clampLux(0)).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('the HomeKit minimum is 0.0001', () => {

    expect(HOMEKIT_AMBIENT_LIGHT_MINIMUM).toBe(0.0001);
  });

  it('passes through the minimum value itself', () => {

    expect(clampLux(HOMEKIT_AMBIENT_LIGHT_MINIMUM)).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('passes through 1 lux', () => {

    expect(clampLux(1)).toBe(1);
  });
});
