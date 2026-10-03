/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * doorbell-duration.test.ts: Tests for doorbell duration handling in DoorbellLcdMessages (protect-doorbell-messages.ts) and DoorbellChimes
 * (protect-doorbell-chimes.ts).
 *
 * Covers MQTT message duration validation and processing, configuration message duration parsing, physical chime duration mapping, and digital chime
 * duration clamping, all exercised through the real delegates against a fake doorbell.
 */
import * as hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL, PROTECT_DOORBELL_MESSAGE_DURATION } from '../src/settings.js';
import { DoorbellChimes } from '../src/devices/protect-doorbell-chimes.js';
import { DoorbellLcdMessages } from '../src/devices/protect-doorbell-messages.js';
import type { MessageInterface } from '../src/devices/protect-doorbell-messages.js';
import type { ProtectDoorbell } from '../src/devices/protect-doorbell.js';
import { ProtectReservedNames } from '../src/protect-types.js';

const NOW = 1_700_000_000_000;

// Options for our fake doorbell.
interface FakeDoorbellOptions {

  configMessages?: Record<string, unknown>[];
  defaultMessageResetTimeoutMs?: number | undefined;
  digitalChimeDuration?: number | undefined;
}

// Build a fake doorbell carrying only what the doorbell delegates consult.
function makeDoorbell(options: FakeDoorbellOptions = {}): ProtectDoorbell & { log: { error: ReturnType<typeof vi.fn> }; mqttSet: (raw: string) => void;
  writeDevice: ReturnType<typeof vi.fn> } {

  let setHandler: ((value: string, rawValue: string) => void) | undefined;

  return {

    api: { hap },
    getFeatureNumber: (option: string): number | undefined =>
      (option === 'Doorbell.PhysicalChime.Duration.Digital') ? options.digitalChimeDuration : undefined,
    hasFeature: (option: string): boolean => option === 'Doorbell.Messages',
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    mqttSet: (raw: string): void => setHandler?.(raw, raw),
    nvr: {

      config: { doorbellMessages: options.configMessages },
      mqtt: {

        subscribeGet: vi.fn(),
        subscribeSet: vi.fn((_mac: string, _topic: string, _name: string, handler: (value: string, rawValue: string) => void) => {

          setHandler = handler;
        }),
      },
      ufp: { doorbellSettings: { allMessages: [], defaultMessageResetTimeoutMs: options.defaultMessageResetTimeoutMs } },
    },
    ufp: { mac: 'DOORBELLMAC' },
    writeDevice: vi.fn(async (): Promise<boolean> => true),
  } as unknown as ProtectDoorbell & { log: { error: ReturnType<typeof vi.fn> }; mqttSet: (raw: string) => void; writeDevice: ReturnType<typeof vi.fn> };
}

// Send a raw MQTT doorbell message through the real handler and return the LCD message written to Protect, if any.
function sendMqtt(raw: string, options: FakeDoorbellOptions = {}): { error: ReturnType<typeof vi.fn>; written: unknown } {

  const doorbell = makeDoorbell(options);

  new DoorbellLcdMessages(doorbell).configureMqtt();
  doorbell.mqttSet(raw);

  return { error: doorbell.log.error, written: doorbell.writeDevice.mock.calls[0]?.[0] };
}

describe('MQTT Message Duration Validation', () => {

  beforeEach(() => {

    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it.each([
    [ 'a positive integer', '30' ],
    [ 'zero', '0' ],
    [ 'a positive float', '5.5' ],
    [ 'a negative number', '-1' ],
  ])('accepts %s', (_label, duration) => {

    const { error, written } = sendMqtt('{ "message": "Hi", "duration": ' + duration + ' }');

    expect(written).toBeDefined();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    [ 'Infinity', '1e999' ],
    [ '-Infinity', '-1e999' ],
    [ 'a string', '"30"' ],
    [ 'null', 'null' ],
  ])('rejects %s', (_label, duration) => {

    const { error, written } = sendMqtt('{ "message": "Hi", "duration": ' + duration + ' }');

    expect(written).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('rejects a payload without a message', () => {

    const { error, written } = sendMqtt('{ "duration": 30 }');

    expect(written).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('rejects invalid JSON', () => {

    const { error, written } = sendMqtt('not json');

    expect(written).toBeUndefined();
    expect(error).toHaveBeenCalledWith('Unable to process MQTT message: "%s". Invalid JSON.', 'not json');
  });
});

describe('MQTT Duration Processing', () => {

  beforeEach(() => {

    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  const lcdMessage = (resetAt: number | null): unknown => ({ lcdMessage: { resetAt, text: 'Hi', type: 'CUSTOM_MESSAGE' } });

  it('converts seconds to milliseconds', () => {

    expect(sendMqtt('{ "message": "Hi", "duration": 30 }').written).toEqual(lcdMessage(NOW + 30000));
  });

  it('uses the built-in default duration when duration is not specified and the controller has none', () => {

    expect(sendMqtt('{ "message": "Hi" }').written).toEqual(lcdMessage(NOW + PROTECT_DOORBELL_MESSAGE_DURATION));
  });

  it("uses the controller's default duration when duration is not specified", () => {

    expect(sendMqtt('{ "message": "Hi" }', { defaultMessageResetTimeoutMs: 15000 }).written).toEqual(lcdMessage(NOW + 15000));
  });

  it('uses the default duration when duration is negative', () => {

    expect(sendMqtt('{ "message": "Hi", "duration": -5 }').written).toEqual(lcdMessage(NOW + PROTECT_DOORBELL_MESSAGE_DURATION));
  });

  it('accepts a duration of 0 as non-expiring', () => {

    expect(sendMqtt('{ "message": "Hi", "duration": 0 }').written).toEqual(lcdMessage(null));
  });

  it('handles fractional seconds', () => {

    expect(sendMqtt('{ "message": "Hi", "duration": 1.5 }').written).toEqual(lcdMessage(NOW + 1500));
  });

  it('resets the message when the message is blank', () => {

    expect(sendMqtt('{ "message": "" }').written).toEqual({ lcdMessage: { resetAt: NOW } });
  });
});

describe('Configuration Message Duration Parsing', () => {

  // Run the real private getMessages() against a single configured message and return the duration it settled on.
  function parseConfigDuration(entry: Record<string, unknown>, defaultMessageResetTimeoutMs?: number): number {

    const messages = new DoorbellLcdMessages(makeDoorbell({ configMessages: [ { message: 'Hi', ...entry } ], defaultMessageResetTimeoutMs })) as unknown as
      { getMessages: () => MessageInterface[] };

    return messages.getMessages()[0]!.duration;
  }

  it('converts seconds to milliseconds for valid duration', () => {

    expect(parseConfigDuration({ duration: 30 })).toBe(30000);
  });

  it('uses default for missing duration', () => {

    expect(parseConfigDuration({})).toBe(PROTECT_DOORBELL_MESSAGE_DURATION);
  });

  it("uses the controller's default for missing duration when it has one", () => {

    expect(parseConfigDuration({}, 20000)).toBe(20000);
  });

  it('uses default for negative duration', () => {

    expect(parseConfigDuration({ duration: -1 })).toBe(PROTECT_DOORBELL_MESSAGE_DURATION);
  });

  it('uses default for NaN duration', () => {

    expect(parseConfigDuration({ duration: NaN })).toBe(PROTECT_DOORBELL_MESSAGE_DURATION);
  });

  it('accepts 0 as non-expiring', () => {

    expect(parseConfigDuration({ duration: 0 })).toBe(0);
  });

  it('tags configured messages as custom messages', () => {

    const messages = new DoorbellLcdMessages(makeDoorbell({ configMessages: [ { duration: 60, message: 'Hi' } ] })) as unknown as
      { getMessages: () => MessageInterface[] };

    expect(messages.getMessages()).toEqual([ { duration: 60000, text: 'Hi', type: 'CUSTOM_MESSAGE' } ]);
  });
});

describe('Physical Chime Duration Mapping', () => {

  const chimes = (digitalChimeDuration?: number): DoorbellChimes => new DoorbellChimes(makeDoorbell({ digitalChimeDuration }));

  it('returns the digital chime duration for digital type', () => {

    expect(chimes().getPhysicalChimeDuration(ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL)).toBe(PROTECT_DOORBELL_CHIME_DURATION_DIGITAL);
  });

  it('returns the mechanical chime constant for mechanical type', () => {

    expect(chimes().getPhysicalChimeDuration(ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL)).toBe(PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL);
  });

  it('returns 0 for none type', () => {

    expect(chimes().getPhysicalChimeDuration(ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE)).toBe(0);
  });

  it('returns 0 for unknown type', () => {

    expect(chimes().getPhysicalChimeDuration('unknown' as ProtectReservedNames)).toBe(0);
  });

  it('digital duration is configurable', () => {

    expect(chimes(2000).getPhysicalChimeDuration(ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL)).toBe(2000);
  });
});

describe('Digital Chime Duration Clamping', () => {

  const digitalDuration = (configured?: number): number => new DoorbellChimes(makeDoorbell({ digitalChimeDuration: configured })).chimeDigitalDuration;

  it('clamps values below 1000 to 1000', () => {

    expect(digitalDuration(500)).toBe(1000);
    expect(digitalDuration(0)).toBe(1000);
    expect(digitalDuration(999)).toBe(1000);
  });

  it('leaves values between 1000 and 10000 unchanged', () => {

    expect(digitalDuration(1000)).toBe(1000);
    expect(digitalDuration(2000)).toBe(2000);
    expect(digitalDuration(10000)).toBe(10000);
  });

  it('clamps values above 10000 to 10000', () => {

    expect(digitalDuration(10001)).toBe(10000);
  });

  it('uses the default digital chime duration when none is configured', () => {

    expect(digitalDuration()).toBe(PROTECT_DOORBELL_CHIME_DURATION_DIGITAL);
    expect(PROTECT_DOORBELL_CHIME_DURATION_DIGITAL).toBeGreaterThanOrEqual(1000);
  });
});
