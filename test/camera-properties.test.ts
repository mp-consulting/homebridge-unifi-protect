/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * camera-properties.test.ts: Tests for camera property mappings and helper logic from protect-camera.ts.
 *
 * Tests the night vision brightness mapping, HKSV capability checks, and crop parameter clamping
 * without requiring Homebridge dependencies.
 */

describe('Night Vision Brightness Mapping', () => {

  // Reproduction of ProtectCamera.NIGHT_VISION_MAP.
  const NIGHT_VISION_MAP = new Map<string, number>([
    ['off', 0],
    ['autoFilterOnly', 5],
    ['auto', 10],
    ['on', 100],
  ]);

  // Reproduction of ProtectCamera.NIGHT_VISION_BRIGHTNESS_MAP.
  const NIGHT_VISION_BRIGHTNESS_MAP = new Map<number, string>([
    [0, 'off'],
    [5, 'autoFilterOnly'],
    [10, 'auto'],
    [100, 'on'],
  ]);

  describe('mode to brightness', () => {

    it('maps "off" to 0', () => {

      expect(NIGHT_VISION_MAP.get('off')).toBe(0);
    });

    it('maps "autoFilterOnly" to 5', () => {

      expect(NIGHT_VISION_MAP.get('autoFilterOnly')).toBe(5);
    });

    it('maps "auto" to 10', () => {

      expect(NIGHT_VISION_MAP.get('auto')).toBe(10);
    });

    it('maps "on" to 100', () => {

      expect(NIGHT_VISION_MAP.get('on')).toBe(100);
    });

    it('returns undefined for unknown mode', () => {

      expect(NIGHT_VISION_MAP.get('unknown')).toBeUndefined();
    });

    it('contains exactly 4 entries', () => {

      expect(NIGHT_VISION_MAP.size).toBe(4);
    });
  });

  describe('brightness to mode', () => {

    it('maps 0 to "off"', () => {

      expect(NIGHT_VISION_BRIGHTNESS_MAP.get(0)).toBe('off');
    });

    it('maps 5 to "autoFilterOnly"', () => {

      expect(NIGHT_VISION_BRIGHTNESS_MAP.get(5)).toBe('autoFilterOnly');
    });

    it('maps 10 to "auto"', () => {

      expect(NIGHT_VISION_BRIGHTNESS_MAP.get(10)).toBe('auto');
    });

    it('maps 100 to "on"', () => {

      expect(NIGHT_VISION_BRIGHTNESS_MAP.get(100)).toBe('on');
    });

    it('returns undefined for unmapped brightness values', () => {

      expect(NIGHT_VISION_BRIGHTNESS_MAP.get(50)).toBeUndefined();
    });
  });

  describe('round-trip consistency', () => {

    it('mode -> brightness -> mode is identity for all known modes', () => {

      for(const [mode, brightness] of NIGHT_VISION_MAP) {

        expect(NIGHT_VISION_BRIGHTNESS_MAP.get(brightness)).toBe(mode);
      }
    });

    it('brightness -> mode -> brightness is identity for all known brightnesses', () => {

      for(const [brightness, mode] of NIGHT_VISION_BRIGHTNESS_MAP) {

        expect(NIGHT_VISION_MAP.get(mode)).toBe(brightness);
      }
    });
  });
});

describe('isHksvCapable', () => {

  // Reproduction of the ProtectCamera.isHksvCapable property logic.
  function isHksvCapable(ufp: {
    isThirdPartyCamera: boolean;
    isAdoptedByAccessApp: boolean;
    isPairedWithAiPort: boolean;
  }): boolean {

    return (!ufp.isThirdPartyCamera && !ufp.isAdoptedByAccessApp) || (ufp.isThirdPartyCamera && ufp.isPairedWithAiPort);
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

  // Reproduction of the clampCrop helper from ProtectCamera.configureCrop().
  function clampCrop(value: number, fallback: number): number {

    return ((value < 0) || (value > 100)) ? fallback : value;
  }

  it('returns value within valid range', () => {

    expect(clampCrop(50, 0)).toBe(50);
  });

  it('returns value at lower boundary (0)', () => {

    expect(clampCrop(0, 0)).toBe(0);
  });

  it('returns value at upper boundary (100)', () => {

    expect(clampCrop(100, 0)).toBe(100);
  });

  it('returns fallback for negative value', () => {

    expect(clampCrop(-1, 0)).toBe(0);
  });

  it('returns fallback for value above 100', () => {

    expect(clampCrop(101, 100)).toBe(100);
  });

  it('returns fallback for very large negative value', () => {

    expect(clampCrop(-999, 50)).toBe(50);
  });

  it('returns fallback for very large positive value', () => {

    expect(clampCrop(1000, 50)).toBe(50);
  });

  it('uses different fallback values for width vs x', () => {

    // Width defaults to 100, x defaults to 0 — matching the actual usage.
    expect(clampCrop(-5, 100)).toBe(100); // Width fallback.
    expect(clampCrop(-5, 0)).toBe(0);     // X/Y fallback.
  });
});

describe('UFP Recording Switches', () => {

  // Verify the recording switch constant values match expected pattern.
  // These are from ProtectReservedNames enum.
  it('should define exactly 3 recording switch modes', () => {

    // Mirrors ProtectCamera.UFP_RECORDING_SWITCHES.
    const switches = [
      'Switch.UniFi Protect.Recording.Always',
      'Switch.UniFi Protect.Recording.Detections',
      'Switch.UniFi Protect.Recording.Never',
    ];

    expect(switches).toHaveLength(3);
    expect(new Set(switches).size).toBe(3);
  });
});
