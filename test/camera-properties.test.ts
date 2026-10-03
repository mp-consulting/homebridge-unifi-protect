/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * camera-properties.test.ts: Tests for camera property helpers in ProtectCamera and the UniFi Protect recording switches in ProtectCameraControls.
 *
 * The night vision mode/brightness mappings are exercised through the real dimmer in night-vision-dimmer.test.ts.
 */
import * as hap from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';
import { ProtectCamera } from '../src/devices/protect-camera.js';
import { ProtectCameraControls } from '../src/devices/protect-camera-controls.js';
import { ProtectReservedNames } from '../src/protect-types.js';

describe('isHksvCapable', () => {

  // The real isHksvCapable getter from ProtectCamera.
  const isHksvCapableGetter = Object.getOwnPropertyDescriptor(ProtectCamera.prototype, 'isHksvCapable')?.get as (this: unknown) => boolean;

  function isHksvCapable(ufp: { isAdoptedByAccessApp: boolean; isPairedWithAiPort: boolean; isThirdPartyCamera: boolean }): boolean {

    return isHksvCapableGetter.call({ ufp });
  }

  it('returns true for native Protect camera', () => {

    expect(isHksvCapable({ isThirdPartyCamera: false, isAdoptedByAccessApp: false, isPairedWithAiPort: false })).toBe(true);
  });

  it('returns false for Access-adopted camera', () => {

    expect(isHksvCapable({ isThirdPartyCamera: false, isAdoptedByAccessApp: true, isPairedWithAiPort: false })).toBe(false);
  });

  it('returns false for third-party camera not paired with AI port', () => {

    expect(isHksvCapable({ isThirdPartyCamera: true, isAdoptedByAccessApp: false, isPairedWithAiPort: false })).toBe(false);
  });

  it('returns true for third-party camera paired with AI port', () => {

    expect(isHksvCapable({ isThirdPartyCamera: true, isAdoptedByAccessApp: false, isPairedWithAiPort: true })).toBe(true);
  });

  it('returns true for third-party + Access-adopted + AI port (third-party path wins)', () => {

    expect(isHksvCapable({ isThirdPartyCamera: true, isAdoptedByAccessApp: true, isPairedWithAiPort: true })).toBe(true);
  });
});

describe('Crop Parameter Clamping', () => {

  // The real private configureCrop() from ProtectCamera.
  const configureCrop = (ProtectCamera.prototype as unknown as { configureCrop: (this: unknown) => boolean }).configureCrop;

  // Run configureCrop() against a fake camera whose crop feature options are set as requested, returning the resulting crop hints.
  function crop(options: Partial<Record<'Height' | 'Width' | 'X' | 'Y', number>>, enabled = true): unknown {

    const hints: Record<string, unknown> = { crop: enabled };

    configureCrop.call({

      getFeatureNumber: (option: string): number | undefined => options[option.slice('Video.Crop.'.length) as keyof typeof options],
      hints,
      log: { info: vi.fn() },
    });

    return hints.cropOptions;
  }

  it('does nothing when cropping is disabled', () => {

    expect(crop({ Width: 50 }, false)).toBeUndefined();
  });

  it('defaults to the full frame when no crop options are set', () => {

    expect(crop({})).toEqual({ height: 1, width: 1, x: 0, y: 0 });
  });

  it('converts in-range percentages to decimals', () => {

    expect(crop({ Height: 50, Width: 75, X: 10, Y: 20 })).toEqual({ height: 0.5, width: 0.75, x: 0.1, y: 0.2 });
  });

  it('accepts the 0 and 100 boundaries', () => {

    expect(crop({ Height: 100, Width: 0, X: 100, Y: 0 })).toEqual({ height: 1, width: 0, x: 1, y: 0 });
  });

  it('falls back to 100% for out-of-range width and height', () => {

    expect(crop({ Height: 101, Width: -1 })).toEqual({ height: 1, width: 1, x: 0, y: 0 });
  });

  it('falls back to 0% for out-of-range x and y', () => {

    expect(crop({ X: -999, Y: 1000 })).toEqual({ height: 1, width: 1, x: 0, y: 0 });
  });
});

describe('UFP Recording Switches', () => {

  const switchTypes = [

    ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS,
    ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS,
    ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER,
  ];

  // Configure the real controls delegate against a fake camera with the recording switches enabled.
  function makeCamera(mode: string): { accessory: hap.Accessory; writeDevice: ReturnType<typeof vi.fn> } {

    const accessory = new hap.Accessory('Camera', hap.uuid.generate('recording-switches-' + mode));
    const writeDevice = vi.fn(async (): Promise<boolean> => true);

    const camera = {

      accessory,
      accessoryName: 'Camera',
      api: { hap },
      hasFeature: (): boolean => false,
      hints: { ledStatus: false, nightVision: false, nightVisionDimmer: false, nvrRecordingSwitch: true },
      isHksvCapable: true,
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      ufp: { ispSettings: { irLedMode: 'auto' }, recordingSettings: { mode, retentionDurationMs: 1 } },
      writeDevice,
    };

    new ProtectCameraControls(camera as unknown as ProtectCamera).configure();

    return { accessory, writeDevice };
  }

  it('creates exactly one switch per Protect recording mode', () => {

    const { accessory } = makeCamera('always');

    expect(accessory.services.filter(service => service.UUID === hap.Service.Switch.UUID).map(service => service.subtype)).toEqual(switchTypes);
  });

  it('turns on only the switch matching the current recording mode', () => {

    const { accessory } = makeCamera('detections');

    expect(switchTypes.map(type => accessory.getServiceById(hap.Service.Switch, type)?.getCharacteristic(hap.Characteristic.On).value))
      .toEqual([ false, true, false ]);
  });

  it('writes the selected mode to Protect, preserving other recording settings, and turns the other switches off', async () => {

    const { accessory, writeDevice } = makeCamera('always');

    await accessory.getServiceById(hap.Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER)?.getCharacteristic(hap.Characteristic.On)
      .handleSetRequest(true);

    expect(writeDevice.mock.calls[0]?.[0]).toEqual({ recordingSettings: { mode: 'never', retentionDurationMs: 1 } });
    expect(accessory.getServiceById(hap.Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS)?.getCharacteristic(hap.Characteristic.On).value)
      .toBe(false);
  });
});
