/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * doorbell-duration.test.ts: Tests for doorbell duration validation and chime logic from protect-doorbell.ts.
 *
 * Covers MQTT message duration validation, configuration message duration parsing, physical chime duration
 * mapping, and digital chime duration clamping.
 */
import {
  PROTECT_DOORBELL_CHIME_DURATION_DIGITAL,
  PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL,
  PROTECT_DOORBELL_MESSAGE_DURATION,
} from '../src/settings.js';

describe('MQTT Message Duration Validation', () => {

  // Reproduction of the validation check from protect-doorbell.ts configureMqtt().
  // Uses Number.isFinite to reject NaN, Infinity, and -Infinity.
  function isValidDuration(duration: unknown): boolean {

    return Number.isFinite(duration);
  }

  it('accepts a positive integer', () => {

    expect(isValidDuration(30)).toBe(true);
  });

  it('accepts zero', () => {

    expect(isValidDuration(0)).toBe(true);
  });

  it('accepts a positive float', () => {

    expect(isValidDuration(5.5)).toBe(true);
  });

  it('accepts a negative number', () => {

    expect(isValidDuration(-1)).toBe(true);
  });

  it('rejects NaN', () => {

    expect(isValidDuration(NaN)).toBe(false);
  });

  it('rejects Infinity', () => {

    expect(isValidDuration(Infinity)).toBe(false);
  });

  it('rejects -Infinity', () => {

    expect(isValidDuration(-Infinity)).toBe(false);
  });

  it('rejects undefined', () => {

    expect(isValidDuration(undefined)).toBe(false);
  });

  it('rejects string', () => {

    expect(isValidDuration('30')).toBe(false);
  });

  it('rejects null', () => {

    expect(isValidDuration(null)).toBe(false);
  });
});

describe('MQTT Duration Processing', () => {

  const DEFAULT_DURATION = PROTECT_DOORBELL_MESSAGE_DURATION;

  // Reproduction of the duration processing logic from protect-doorbell.ts configureMqtt().
  function processMqttDuration(payload: { duration?: number }): number {

    if(!('duration' in payload) || (('duration' in payload) && ((payload.duration ?? 0) < 0))) {

      return DEFAULT_DURATION;
    }

    return (payload.duration ?? 0) * 1000;
  }

  it('converts seconds to milliseconds', () => {

    expect(processMqttDuration({ duration: 30 })).toBe(30000);
  });

  it('uses default duration when duration is not specified', () => {

    expect(processMqttDuration({})).toBe(DEFAULT_DURATION);
  });

  it('uses default duration when duration is negative', () => {

    expect(processMqttDuration({ duration: -1 })).toBe(DEFAULT_DURATION);
  });

  it('accepts duration of 0 (non-expiring)', () => {

    expect(processMqttDuration({ duration: 0 })).toBe(0);
  });

  it('handles fractional seconds', () => {

    expect(processMqttDuration({ duration: 1.5 })).toBe(1500);
  });
});

describe('Configuration Message Duration Parsing', () => {

  const DEFAULT_DURATION = PROTECT_DOORBELL_MESSAGE_DURATION;

  // Reproduction of the duration parsing from protect-doorbell.ts getMessages().
  function parseConfigDuration(entry: { duration?: number }): number {

    let duration = DEFAULT_DURATION;

    if(('duration' in entry) && !isNaN(entry.duration as number) && ((entry.duration as number) >= 0)) {

      duration = (entry.duration as number) * 1000;
    }

    return duration;
  }

  it('converts seconds to milliseconds for valid duration', () => {

    expect(parseConfigDuration({ duration: 30 })).toBe(30000);
  });

  it('uses default for missing duration', () => {

    expect(parseConfigDuration({})).toBe(DEFAULT_DURATION);
  });

  it('uses default for negative duration', () => {

    expect(parseConfigDuration({ duration: -1 })).toBe(DEFAULT_DURATION);
  });

  it('uses default for NaN duration', () => {

    expect(parseConfigDuration({ duration: NaN })).toBe(DEFAULT_DURATION);
  });

  it('accepts 0 as non-expiring', () => {

    expect(parseConfigDuration({ duration: 0 })).toBe(0);
  });

  it('converts 60 seconds to 60000ms', () => {

    expect(parseConfigDuration({ duration: 60 })).toBe(60000);
  });
});

describe('Physical Chime Duration Mapping', () => {

  // Physical chime types and their corresponding duration constants.
  const CHIME_DIGITAL = 'Switch.Doorbell.PhysicalChime.Digital';
  const CHIME_MECHANICAL = 'Switch.Doorbell.PhysicalChime.Mechanical';
  const CHIME_NONE = 'Switch.Doorbell.PhysicalChime.None';

  // Reproduction of getPhysicalChimeDuration from protect-doorbell.ts.
  function getPhysicalChimeDuration(physicalChimeType: string, digitalDuration: number): number {

    switch(physicalChimeType) {

      case CHIME_DIGITAL:

        return digitalDuration;

      case CHIME_MECHANICAL:

        return PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL;

      case CHIME_NONE:
      default:

        return 0;
    }
  }

  it('returns the digital chime duration for digital type', () => {

    expect(getPhysicalChimeDuration(CHIME_DIGITAL, 1000)).toBe(1000);
  });

  it('returns the mechanical chime constant for mechanical type', () => {

    expect(getPhysicalChimeDuration(CHIME_MECHANICAL, 1000)).toBe(PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL);
  });

  it('returns 0 for none type', () => {

    expect(getPhysicalChimeDuration(CHIME_NONE, 1000)).toBe(0);
  });

  it('returns 0 for unknown type', () => {

    expect(getPhysicalChimeDuration('unknown', 1000)).toBe(0);
  });

  it('digital duration is configurable', () => {

    expect(getPhysicalChimeDuration(CHIME_DIGITAL, 2000)).toBe(2000);
    expect(getPhysicalChimeDuration(CHIME_DIGITAL, 500)).toBe(500);
  });
});

describe('Digital Chime Duration Clamping', () => {

  // Reproduction of the clamping in ProtectDoorbell constructor.
  function clampDigitalChimeDuration(duration: number): number {

    if(duration < 1000) {

      return 1000;
    }

    return duration;
  }

  it('clamps values below 1000 to 1000', () => {

    expect(clampDigitalChimeDuration(500)).toBe(1000);
    expect(clampDigitalChimeDuration(0)).toBe(1000);
    expect(clampDigitalChimeDuration(999)).toBe(1000);
  });

  it('leaves values at or above 1000 unchanged', () => {

    expect(clampDigitalChimeDuration(1000)).toBe(1000);
    expect(clampDigitalChimeDuration(2000)).toBe(2000);
    expect(clampDigitalChimeDuration(5000)).toBe(5000);
  });

  it('the default digital chime duration is at least 1000ms', () => {

    expect(PROTECT_DOORBELL_CHIME_DURATION_DIGITAL).toBeGreaterThanOrEqual(1000);
  });
});
