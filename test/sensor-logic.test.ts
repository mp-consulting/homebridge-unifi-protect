/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * sensor-logic.test.ts: Tests for ProtectCameraSensors (protect-camera-sensors.ts).
 *
 * Covers license plate feature value parsing and ambient light lux clamping, exercised through the real delegate against a fake camera.
 */
import * as hap from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';
import { HOMEKIT_AMBIENT_LIGHT_MINIMUM } from '../src/settings.js';
import type { ProtectCamera } from '../src/devices/protect-camera.js';
import { ProtectCameraSensors } from '../src/devices/protect-camera-sensors.js';
import { ProtectReservedNames } from '../src/protect-types.js';

// Options for our fake camera.
interface FakeCameraOptions {

  isOnline?: boolean;
  licensePlates?: string | null | undefined;
  luxBody?: unknown;
  smartDetect?: boolean;
  statusCode?: number;
}

// Build a fake camera carrying only what ProtectCameraSensors consults.
function makeCamera(options: FakeCameraOptions = {}): ProtectCamera {

  const statusCode = options.statusCode ?? 200;

  return {

    accessory: new hap.Accessory('Camera', hap.uuid.generate('sensor-logic-' + JSON.stringify(options))),
    accessoryName: 'Camera',
    api: { hap },
    getFeatureValue: (option: string): string | null | undefined =>
      (option === 'Motion.SmartDetect.ObjectSensors.LicensePlate') ? options.licensePlates : undefined,
    hints: { smartDetectSensors: false },
    isOnline: options.isOnline ?? true,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    nvr: {

      mqtt: null,
      ufpApi: {

        getApiEndpoint: (modelKey: string): string => '/api/' + modelKey + 's',
        responseOk: (code?: number): boolean => (code !== undefined) && (code >= 200) && (code < 300),
        retrieve: vi.fn(async (): Promise<unknown> => ({ body: { json: async (): Promise<unknown> => options.luxBody ?? {} }, statusCode })),
      },
    },
    ufp: {

      featureFlags: { hasLuxCheck: true, hasSmartDetect: options.smartDetect ?? false, smartDetectAudioTypes: [],
        smartDetectTypes: options.smartDetect ? [ 'licensePlate' ] : [] },
      id: 'camera-id',
      mac: 'CAMERAMAC',
      modelKey: 'camera',
    },
  } as unknown as ProtectCamera;
}

// Run the real smart sensor configuration and return the license plates it parsed.
function parseLicensePlates(featureValue: string | null | undefined): string[] {

  const sensors = new ProtectCameraSensors(makeCamera({ licensePlates: featureValue }));

  (sensors as unknown as { configureSmartSensors: () => boolean }).configureSmartSensors();

  return sensors.detectLicensePlate;
}

// Configure the real ambient light sensor and return the light level it reports to HomeKit.
async function ambientLight(options: FakeCameraOptions): Promise<unknown> {

  const camera = makeCamera(options);
  const sensors = new ProtectCameraSensors(camera);

  try {

    await expect(sensors.configureAmbientLight()).resolves.toBe(true);

    return camera.accessory.getService(hap.Service.LightSensor)?.getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel).value;
  } finally {

    sensors.cleanup();
  }
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

  it('handles mixed case', () => {

    expect(parseLicensePlates('AbC123-dEf456')).toEqual(['ABC123', 'DEF456']);
  });

  it('creates a contact sensor per configured plate when license plate detection is available', () => {

    const camera = makeCamera({ licensePlates: 'abc-def', smartDetect: true });

    new ProtectCameraSensors(camera).configure();

    const subtypes = camera.accessory.services.map(service => service.subtype);

    expect(subtypes.filter(subtype => subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE))).toEqual([ ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.ABC', ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + '.DEF' ]);
  });
});

describe('Ambient Light Lux Clamping', () => {

  it('passes through positive lux values unchanged', async () => {

    expect(await ambientLight({ luxBody: { illuminance: 100 } })).toBe(100);
    expect(await ambientLight({ luxBody: { illuminance: 0.5 } })).toBe(0.5);
    expect(await ambientLight({ luxBody: { illuminance: 50000 } })).toBe(50000);
  });

  it('clamps 0 to the HomeKit minimum', async () => {

    expect(await ambientLight({ luxBody: { illuminance: 0 } })).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('clamps a missing illuminance to the HomeKit minimum', async () => {

    expect(await ambientLight({ luxBody: {} })).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('falls back to the HomeKit minimum when the camera is offline', async () => {

    expect(await ambientLight({ isOnline: false, luxBody: { illuminance: 100 } })).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('falls back to the HomeKit minimum when Protect rejects the request', async () => {

    expect(await ambientLight({ luxBody: { illuminance: 100 }, statusCode: 500 })).toBe(HOMEKIT_AMBIENT_LIGHT_MINIMUM);
  });

  it('the HomeKit minimum is 0.0001', () => {

    expect(HOMEKIT_AMBIENT_LIGHT_MINIMUM).toBe(0.0001);
  });
});
