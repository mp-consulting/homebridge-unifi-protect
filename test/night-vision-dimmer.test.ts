/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * night-vision-dimmer.test.ts: Tests for night vision dimmer brightness snapping and custom range interpolation
 * from protect-camera-controls.ts.
 *
 * The dimmer maps HomeKit brightness (0-100) to Protect night vision modes. Fixed thresholds snap to named modes,
 * while the 20-90 range interpolates to icrCustomValue (0-10) for fine-grained control.
 */

// Reproduction of the brightness snapping logic from the dimmer's onSet handler.
function snapBrightness(level: number): number {

  if(level < 5) {

    level = 0;
  } else if(level < 10) {

    level = 5;
  } else if(level < 20) {

    level = 10;
  } else if(level > 90) {

    level = 100;
  }

  return level;
}

// Reproduction of NIGHT_VISION_BRIGHTNESS_MAP from protect-camera-controls.ts.
const NIGHT_VISION_BRIGHTNESS_MAP = new Map<number, string>([

  [0, 'off'],
  [5, 'autoFilterOnly'],
  [10, 'auto'],
  [100, 'on'],
]);

// Reproduction of the custom range mapping: brightness (20-90) → icrCustomValue (0-10) → quantized brightness.
function brightnessToIcr(level: number): number {

  return Math.round((level - 20) / 7);
}

function icrToBrightness(icr: number): number {

  return (icr * 7) + 20;
}

// Reproduction of the nightVision getter from protect-camera-controls.ts.
function isNightVisionOn(irLedMode: string): boolean {

  return irLedMode !== 'off';
}

// Reproduction of the nightVisionBrightness getter.
const NIGHT_VISION_MAP = new Map<string, number>([

  ['off', 0],
  ['autoFilterOnly', 5],
  ['auto', 10],
  ['on', 100],
]);

function nightVisionBrightness(irLedMode: string, icrCustomValue: number): number {

  const brightness = NIGHT_VISION_MAP.get(irLedMode);

  if(brightness !== undefined) {

    return brightness;
  }

  if((irLedMode === 'custom') || (irLedMode === 'customFilterOnly')) {

    return (icrCustomValue * 7) + 20;
  }

  return 0;
}

describe('Night Vision Dimmer - Brightness Snapping', () => {

  describe('fixed thresholds', () => {

    it('snaps 0 to 0 (off)', () => {

      expect(snapBrightness(0)).toBe(0);
    });

    it('snaps 4 to 0 (off)', () => {

      expect(snapBrightness(4)).toBe(0);
    });

    it('snaps 5 to 5 (autoFilterOnly)', () => {

      expect(snapBrightness(5)).toBe(5);
    });

    it('snaps 9 to 5 (autoFilterOnly)', () => {

      expect(snapBrightness(9)).toBe(5);
    });

    it('snaps 10 to 10 (auto)', () => {

      expect(snapBrightness(10)).toBe(10);
    });

    it('snaps 19 to 10 (auto)', () => {

      expect(snapBrightness(19)).toBe(10);
    });

    it('snaps 91 to 100 (on)', () => {

      expect(snapBrightness(91)).toBe(100);
    });

    it('snaps 100 to 100 (on)', () => {

      expect(snapBrightness(100)).toBe(100);
    });
  });

  describe('custom range pass-through (20-90)', () => {

    it('passes through 20 unchanged', () => {

      expect(snapBrightness(20)).toBe(20);
    });

    it('passes through 50 unchanged', () => {

      expect(snapBrightness(50)).toBe(50);
    });

    it('passes through 90 unchanged', () => {

      expect(snapBrightness(90)).toBe(90);
    });
  });

  describe('all snapped values map to a known mode or custom range', () => {

    it('every integer 0-100 snaps to a value the BRIGHTNESS_MAP knows or to 20-90', () => {

      for(let i = 0; i <= 100; i++) {

        const snapped = snapBrightness(i);

        // Must be either a fixed mode or in the custom range [20, 90].
        expect(NIGHT_VISION_BRIGHTNESS_MAP.has(snapped) || (snapped >= 20 && snapped <= 90)).toBe(true);
      }
    });
  });
});

describe('Night Vision Dimmer - Custom Range Interpolation', () => {

  describe('brightness to icrCustomValue', () => {

    it('maps brightness 20 to icr 0', () => {

      expect(brightnessToIcr(20)).toBe(0);
    });

    it('maps brightness 27 to icr 1', () => {

      expect(brightnessToIcr(27)).toBe(1);
    });

    it('maps brightness 55 to icr 5', () => {

      expect(brightnessToIcr(55)).toBe(5);
    });

    it('maps brightness 90 to icr 10', () => {

      expect(brightnessToIcr(90)).toBe(10);
    });
  });

  describe('round-trip: brightness → icr → brightness is stable', () => {

    it('every value in 20-90 round-trips to a stable brightness', () => {

      for(let brightness = 20; brightness <= 90; brightness++) {

        const icr = brightnessToIcr(brightness);
        const roundTrip = icrToBrightness(icr);
        const secondIcr = brightnessToIcr(roundTrip);

        // The quantized brightness should produce the same icr (idempotent after one round-trip).
        expect(secondIcr).toBe(icr);
      }
    });

    it('icr values 0-10 produce round-trip stable brightnesses', () => {

      for(let icr = 0; icr <= 10; icr++) {

        const brightness = icrToBrightness(icr);
        const roundTripIcr = brightnessToIcr(brightness);

        expect(roundTripIcr).toBe(icr);
      }
    });
  });

  describe('icr range bounds', () => {

    it('icr 0 maps to brightness 20', () => {

      expect(icrToBrightness(0)).toBe(20);
    });

    it('icr 10 maps to brightness 90', () => {

      expect(icrToBrightness(10)).toBe(90);
    });
  });
});

describe('Night Vision Getter', () => {

  it('returns false for "off" mode', () => {

    expect(isNightVisionOn('off')).toBe(false);
  });

  it('returns true for "auto" mode', () => {

    expect(isNightVisionOn('auto')).toBe(true);
  });

  it('returns true for "on" mode', () => {

    expect(isNightVisionOn('on')).toBe(true);
  });

  it('returns true for "autoFilterOnly" mode', () => {

    expect(isNightVisionOn('autoFilterOnly')).toBe(true);
  });

  it('returns true for "custom" mode', () => {

    expect(isNightVisionOn('custom')).toBe(true);
  });

  it('returns true for "customFilterOnly" mode', () => {

    expect(isNightVisionOn('customFilterOnly')).toBe(true);
  });
});

describe('Night Vision Brightness Getter', () => {

  it('returns correct brightness for fixed modes', () => {

    expect(nightVisionBrightness('off', 0)).toBe(0);
    expect(nightVisionBrightness('autoFilterOnly', 0)).toBe(5);
    expect(nightVisionBrightness('auto', 0)).toBe(10);
    expect(nightVisionBrightness('on', 0)).toBe(100);
  });

  it('interpolates custom mode brightness from icrCustomValue', () => {

    expect(nightVisionBrightness('custom', 0)).toBe(20);
    expect(nightVisionBrightness('custom', 5)).toBe(55);
    expect(nightVisionBrightness('custom', 10)).toBe(90);
  });

  it('interpolates customFilterOnly mode brightness from icrCustomValue', () => {

    expect(nightVisionBrightness('customFilterOnly', 0)).toBe(20);
    expect(nightVisionBrightness('customFilterOnly', 5)).toBe(55);
    expect(nightVisionBrightness('customFilterOnly', 10)).toBe(90);
  });

  it('returns 0 for unknown modes', () => {

    expect(nightVisionBrightness('unknown', 0)).toBe(0);
  });
});
