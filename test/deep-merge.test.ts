/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * deep-merge.test.ts: Tests for the deep merge algorithm used by updateUfp in protect-events.ts.
 *
 * The merge logic is tested in isolation by reproducing the algorithm from protect-events.ts
 * without requiring Homebridge dependencies.
 */

// Reproduction of the mergeJson algorithm from ProtectEvents.updateUfp.
function mergeJson(...objects: Record<string, unknown>[]): Record<string, unknown> {

  const result = {} as Record<string, unknown>;
  const isObject = (value: unknown): value is Record<string, unknown> => (typeof value === 'object') && !Array.isArray(value) && (value !== null);

  for(const object of objects) {

    for(const key of Object.keys(object).filter(key => Object.hasOwn(object, key))) {

      const existingValue = result[key];
      const newValue = object[key];

      if(isObject(existingValue) && isObject(newValue)) {

        result[key] = mergeJson(existingValue, newValue);

        continue;
      }

      result[key] = newValue;
    }
  }

  return result;
}

describe('Deep Merge (updateUfp algorithm)', () => {

  it('merges flat objects', () => {

    const base = { a: 1, b: 2 };
    const patch = { b: 3, c: 4 };

    expect(mergeJson(base, patch)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deep-merges nested objects', () => {

    const base = { settings: { volume: 50, brightness: 80 }, name: 'cam' };
    const patch = { settings: { volume: 75 } };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ settings: { volume: 75, brightness: 80 }, name: 'cam' });
  });

  it('replaces arrays instead of merging them', () => {

    const base = { channels: [1, 2, 3], name: 'test' };
    const patch = { channels: [4, 5] };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ channels: [4, 5], name: 'test' });
  });

  it('replaces a nested object with an array', () => {

    const base = { data: { a: 1 } };
    const patch = { data: [1, 2, 3] };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it('replaces an array with a nested object', () => {

    const base = { data: [1, 2, 3] };
    const patch = { data: { a: 1 } };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ data: { a: 1 } });
  });

  it('handles null values in patch', () => {

    const base = { a: 1, b: { nested: true } };
    const patch = { b: null };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ a: 1, b: null });
  });

  it('handles undefined values in patch', () => {

    const base = { a: 1, b: 2 };
    const patch = { b: undefined };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ a: 1, b: undefined });
  });

  it('deep-merges three or more levels', () => {

    const base = { l1: { l2: { l3: { val: 'old' }, other: true } } };
    const patch = { l1: { l2: { l3: { val: 'new' } } } };

    const result = mergeJson(base, patch);

    expect(result).toEqual({ l1: { l2: { l3: { val: 'new' }, other: true } } });
  });

  it('does not mutate the original objects', () => {

    const base = { settings: { volume: 50 } };
    const patch = { settings: { volume: 75 } };

    mergeJson(base, patch);

    expect(base.settings.volume).toBe(50);
    expect(patch.settings.volume).toBe(75);
  });

  it('handles an empty patch', () => {

    const base = { a: 1, b: 2 };
    const patch = {};

    expect(mergeJson(base, patch)).toEqual({ a: 1, b: 2 });
  });

  it('handles an empty base', () => {

    const base = {};
    const patch = { a: 1, b: { c: 2 } };

    expect(mergeJson(base, patch)).toEqual({ a: 1, b: { c: 2 } });
  });

  it('handles both empty', () => {

    expect(mergeJson({}, {})).toEqual({});
  });

  it('handles string values', () => {

    const base = { name: 'Camera A', host: '192.168.1.1' };
    const patch = { name: 'Camera B' };

    expect(mergeJson(base, patch)).toEqual({ name: 'Camera B', host: '192.168.1.1' });
  });

  it('handles boolean values', () => {

    const base = { isConnected: true, isManaged: false };
    const patch = { isConnected: false };

    expect(mergeJson(base, patch)).toEqual({ isConnected: false, isManaged: false });
  });

  it('simulates a Protect camera config update', () => {

    const cameraConfig = {
      id: 'abc123',
      name: 'Front Door',
      channels: [
        { id: 0, width: 3840, height: 2160, isRtspEnabled: true },
        { id: 1, width: 1920, height: 1080, isRtspEnabled: true },
      ],
      ispSettings: { brightness: 50, contrast: 50, irLedMode: 'auto' },
      ledSettings: { isEnabled: true, blinkRate: 0 },
      recordingSettings: { mode: 'always', prePaddingSecs: 2 },
    };

    const updatePayload = {
      ispSettings: { irLedMode: 'off' },
      ledSettings: { isEnabled: false },
    };

    const result = mergeJson(
      cameraConfig as unknown as Record<string, unknown>,
      updatePayload as unknown as Record<string, unknown>,
    );

    // Nested objects should be deep-merged.
    expect(result.ispSettings).toEqual({ brightness: 50, contrast: 50, irLedMode: 'off' });
    expect(result.ledSettings).toEqual({ isEnabled: false, blinkRate: 0 });

    // Unmodified fields should remain.
    expect(result.name).toBe('Front Door');
    expect(result.channels).toEqual(cameraConfig.channels);
    expect(result.recordingSettings).toEqual(cameraConfig.recordingSettings);
  });

  it('simulates a Protect NVR config update', () => {

    const nvrConfig = {
      host: '192.168.1.1',
      ports: { rtsp: 7447, rtsps: 7441, ump: 7442 },
      isConnectedToCloud: true,
    };

    const updatePayload = {
      ports: { rtsp: 7448 },
      isConnectedToCloud: false,
    };

    const result = mergeJson(
      nvrConfig as unknown as Record<string, unknown>,
      updatePayload as unknown as Record<string, unknown>,
    );

    expect(result.ports).toEqual({ rtsp: 7448, rtsps: 7441, ump: 7442 });
    expect(result.isConnectedToCloud).toBe(false);
    expect(result.host).toBe('192.168.1.1');
  });

  it('filters out inherited prototype properties', () => {

    const proto = { inherited: true };
    const base = Object.create(proto) as Record<string, unknown>;
    base.own = 'value';

    const result = mergeJson(base, { other: 1 });

    // The inherited property should not appear in the result.
    expect(result).toEqual({ own: 'value', other: 1 });
    expect('inherited' in result).toBe(false);
  });
});
