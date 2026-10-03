/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * night-vision-dimmer.test.ts: Tests for the night vision dimmer and night vision characteristics in ProtectCameraControls (protect-camera-controls.ts).
 *
 * The dimmer maps HomeKit brightness (0-100) to Protect night vision modes. Fixed thresholds snap to named modes, while the 20-90 range interpolates to
 * icrCustomValue (0-10) for fine-grained control. These tests drive the real ProtectCameraControls through HAP characteristics on a fake camera.
 */
import * as hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAccessory } from 'homebridge';
import { PROTECT_HOMEKIT_UPDATE_DELAY } from '../src/settings.js';
import type { ProtectCamera } from '../src/devices/protect-camera.js';
import { ProtectCameraControls } from '../src/devices/protect-camera-controls.js';
import { ProtectReservedNames } from '../src/protect-types.js';

// The pieces of our fake camera that tests inspect.
interface FakeCamera {

  accessory: PlatformAccessory;
  log: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  ufp: { ispSettings: { icrCustomValue: number; irLedMode: string } };
  writeDevice: ReturnType<typeof vi.fn>;
}

// Build a fake camera with the night vision dimmer enabled and configure the real controls delegate against it.
function makeControls(irLedMode = 'auto', icrCustomValue = 0): { camera: FakeCamera; dimmer: hap.Service } {

  const accessory = new hap.Accessory('Camera', hap.uuid.generate('night-vision-' + irLedMode + icrCustomValue.toString()));

  const camera = {

    accessory,
    accessoryName: 'Camera',
    api: { hap },
    hasFeature: (): boolean => false,
    hints: { ledStatus: false, nightVision: false, nightVisionDimmer: true, nvrRecordingSwitch: false },
    isHksvCapable: true,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ufp: { ispSettings: { icrCustomValue, irLedMode }, recordingSettings: { mode: 'always' } },
    writeDevice: vi.fn(async (): Promise<boolean> => true),
  };

  new ProtectCameraControls(camera as unknown as ProtectCamera).configure();

  const dimmer = accessory.getServiceById(hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

  if(!dimmer) {

    throw new Error('Night vision dimmer was not created.');
  }

  return { camera: camera as unknown as FakeCamera, dimmer };
}

// Set the dimmer brightness through HomeKit and return what was written to Protect along with the brightness HomeKit is updated to afterwards.
async function setBrightness(value: number, irLedMode = 'auto'): Promise<{ brightness: unknown; written: unknown }> {

  const { camera, dimmer } = makeControls(irLedMode);

  await dimmer.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(value);
  vi.advanceTimersByTime(PROTECT_HOMEKIT_UPDATE_DELAY);

  return { brightness: dimmer.getCharacteristic(hap.Characteristic.Brightness).value, written: camera.writeDevice.mock.calls[0]?.[0] };
}

describe('Night Vision Dimmer - Brightness Snapping', () => {

  beforeEach(() => {

    vi.useFakeTimers();
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  describe('fixed thresholds', () => {

    it.each([
      [ 0, 0, 'off' ],
      [ 4, 0, 'off' ],
      [ 5, 5, 'autoFilterOnly' ],
      [ 9, 5, 'autoFilterOnly' ],
      [ 10, 10, 'auto' ],
      [ 19, 10, 'auto' ],
      [ 91, 100, 'on' ],
      [ 100, 100, 'on' ],
    ])('snaps %i to %i (%s)', async (input, snapped, mode) => {

      const { brightness, written } = await setBrightness(input);

      expect(written).toEqual({ ispSettings: { irLedMode: mode } });
      expect(brightness).toBe(snapped);
    });
  });

  describe('custom range interpolation (20-90)', () => {

    it.each([
      [ 20, 0, 20 ],
      [ 27, 1, 27 ],
      [ 50, 4, 48 ],
      [ 55, 5, 55 ],
      [ 90, 10, 90 ],
    ])('maps brightness %i to icrCustomValue %i and reports %i back to HomeKit', async (input, icr, quantized) => {

      const { brightness, written } = await setBrightness(input);

      expect(written).toEqual({ ispSettings: { icrCustomValue: icr, irLedMode: 'custom' } });
      expect(brightness).toBe(quantized);
    });

    it('uses customFilterOnly when the camera is currently in a filter-only mode', async () => {

      const { written } = await setBrightness(55, 'autoFilterOnly');

      expect(written).toEqual({ ispSettings: { icrCustomValue: 5, irLedMode: 'customFilterOnly' } });
    });

    it('every value in 20-90 settles on a brightness that round-trips to the same icrCustomValue', async () => {

      for(let input = 20; input <= 90; input++) {

        const first = await setBrightness(input);
        const second = await setBrightness(first.brightness as number);

        expect((second.written as { ispSettings: { icrCustomValue: number } }).ispSettings.icrCustomValue)
          .toBe((first.written as { ispSettings: { icrCustomValue: number } }).ispSettings.icrCustomValue);
        expect(second.brightness).toBe(first.brightness);
      }
    });
  });
});

describe('Night Vision Dimmer - On/Off', () => {

  it('turning off writes the off mode', async () => {

    const { camera, dimmer } = makeControls('auto');

    await dimmer.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);

    expect(camera.writeDevice.mock.calls[0]?.[0]).toEqual({ ispSettings: { irLedMode: 'off' } });
  });

  it('turning on restores the mode implied by the current brightness', async () => {

    const { camera, dimmer } = makeControls('off');

    dimmer.updateCharacteristic(hap.Characteristic.Brightness, 5);
    await dimmer.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);

    expect(camera.writeDevice.mock.calls[0]?.[0]).toEqual({ ispSettings: { irLedMode: 'autoFilterOnly' } });
  });

  it('turning on at a custom brightness selects the custom mode', async () => {

    const { camera, dimmer } = makeControls('off');

    dimmer.updateCharacteristic(hap.Characteristic.Brightness, 55);
    await dimmer.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);

    expect(camera.writeDevice.mock.calls[0]?.[0]).toEqual({ ispSettings: { irLedMode: 'custom' } });
  });
});

describe('Night Vision Getter', () => {

  it.each([
    [ 'off', false ],
    [ 'auto', true ],
    [ 'on', true ],
    [ 'autoFilterOnly', true ],
    [ 'custom', true ],
    [ 'customFilterOnly', true ],
  ])('reports On for mode "%s" as %s', async (mode, expected) => {

    const { dimmer } = makeControls(mode);

    expect(dimmer.getCharacteristic(hap.Characteristic.On).value).toBe(expected);
    await expect(dimmer.getCharacteristic(hap.Characteristic.On).handleGetRequest()).resolves.toBe(expected);
  });
});

describe('Night Vision Brightness Getter', () => {

  it.each([
    [ 'off', 0, 0 ],
    [ 'autoFilterOnly', 0, 5 ],
    [ 'auto', 0, 10 ],
    [ 'on', 0, 100 ],
    [ 'custom', 0, 20 ],
    [ 'custom', 5, 55 ],
    [ 'custom', 10, 90 ],
    [ 'customFilterOnly', 0, 20 ],
    [ 'customFilterOnly', 5, 55 ],
    [ 'customFilterOnly', 10, 90 ],
  ])('reports mode "%s" with icrCustomValue %i as brightness %i', async (mode, icr, expected) => {

    const { dimmer } = makeControls(mode, icr);

    await expect(dimmer.getCharacteristic(hap.Characteristic.Brightness).handleGetRequest()).resolves.toBe(expected);
  });

  it('returns 0 and logs an error for unknown modes', async () => {

    const { camera, dimmer } = makeControls('unknown');

    await expect(dimmer.getCharacteristic(hap.Characteristic.Brightness).handleGetRequest()).resolves.toBe(0);
    expect(camera.log.error).toHaveBeenCalledWith('Unknown night vision value detected: %s.', 'unknown');
  });
});
