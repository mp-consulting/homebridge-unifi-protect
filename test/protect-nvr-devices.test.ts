/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-nvr-devices.test.ts: Tests for the device-by-id index maintained by ProtectNvr as devices are added to and removed from HomeKit.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAccessory } from 'homebridge';
import type { ProtectDeviceConfigTypes } from '../src/protect-types.js';
import { ProtectNvr } from '../src/protect-nvr.js';
import type { ProtectNvrConfig } from '../src/unifi/index.js';
import type { ProtectPlatform } from '../src/protect-platform.js';

// Replace the device classes with lightweight stand-ins that record the configuration they were created with, as the real classes would.
vi.mock('../src/devices/index.js', () => {

  class FakeDevice {

    public accessory: PlatformAccessory;
    public cleanup = vi.fn();
    public ufp: ProtectDeviceConfigTypes;

    constructor(nvr: ProtectNvr, ufp: ProtectDeviceConfigTypes, accessory: PlatformAccessory) {

      this.accessory = accessory;
      this.ufp = ufp;
      Object.assign(accessory.context, { mac: ufp.mac, nvr: nvr.ufp.mac });
    }
  }

  class ProtectCamera extends FakeDevice {}
  class ProtectDoorbell extends FakeDevice {}
  class ProtectChime extends FakeDevice {}
  class ProtectLight extends FakeDevice {}
  class ProtectSensor extends FakeDevice {}
  class ProtectViewer extends FakeDevice {}

  return {

    ProtectCamera, ProtectChime, ProtectDoorbell, ProtectLight, ProtectLiveviews: class {}, ProtectNvrSystemInfo: class {}, ProtectSensor, ProtectViewer,
  };
});

// A minimal stand-in for Homebridge's PlatformAccessory.
class FakeAccessory {

  public _associatedHAPAccessory = { bridged: true };
  public context: Record<string, unknown> = {};
  public services = [];

  constructor(public displayName: string, public UUID: string) {}

  public getService(): undefined {

    return undefined;
  }
}

function makeNvr(): { nvr: ProtectNvr, platform: ProtectPlatform } {

  const api = {

    hap: { Characteristic: {}, Service: { SecuritySystem: 'SecuritySystem' }, uuid: { generate: (value: string): string => 'uuid-' + value } },
    on: vi.fn(),
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  };

  const platform = {

    accessories: [] as PlatformAccessory[],
    api,
    debug: vi.fn(),
    featureOptions: { getInteger: (): null => null, scope: (): string => 'global', test: (option: string): boolean => option !== 'Device.Standalone' },
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    tlsPins: { filename: 'pins.json', get: (): undefined => undefined, set: vi.fn() },
  } as unknown as ProtectPlatform;

  const nvr = new ProtectNvr(platform, { address: '1.2.3.4', mqttTopic: 'unifi/protect', password: 'p', username: 'u' });

  nvr.ufp = { mac: 'NVRMAC' } as ProtectNvrConfig;

  return { nvr, platform };
}

function makeCamera(id: string, mac: string): ProtectDeviceConfigTypes {

  return { featureFlags: { isDoorbell: false }, id, isAdopted: true, isAdoptedByOther: false, mac, modelKey: 'camera', name: 'Camera ' + id } as
    unknown as ProtectDeviceConfigTypes;
}

describe('ProtectNvr device index', () => {

  it('indexes devices by id as they are added and removed', () => {

    const { nvr, platform } = makeNvr();

    expect(nvr.getDeviceById('cam1')).toBeNull();

    expect(nvr.addHomeKitDevice(makeCamera('cam1', 'AA'))).toBe(true);
    expect(nvr.addHomeKitDevice(makeCamera('cam2', 'BB'))).toBe(true);

    const camera1 = nvr.getDeviceById('cam1');

    expect(camera1?.ufp.mac).toBe('AA');
    expect(nvr.getDeviceById('cam2')?.ufp.mac).toBe('BB');
    expect(camera1).toBe(nvr.configuredDevices['uuid-AA']);

    // Removing the accessory removes the device from the index and cleans it up.
    nvr.removeHomeKitDevice(platform.accessories.find(x => x.UUID === 'uuid-AA') as PlatformAccessory, true);

    expect(nvr.getDeviceById('cam1')).toBeNull();
    expect(nvr.getDeviceById('cam2')).not.toBeNull();
    expect(camera1?.cleanup).toHaveBeenCalled();

    // Readding the device indexes the new instance.
    nvr.addHomeKitDevice(makeCamera('cam1', 'AA'));

    expect(nvr.getDeviceById('cam1')).not.toBeNull();
    expect(nvr.getDeviceById('cam1')).not.toBe(camera1);
  });
});
