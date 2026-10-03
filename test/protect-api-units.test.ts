/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api-units.test.ts: Unit tests for the UniFi Protect API circuit breaker, event packet inflate cap, and TLS pin store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { CircuitBreaker } from '../src/unifi/protect-api-circuit-breaker.js';
import { EVENT_PACKET_MAX_INFLATED_SIZE } from '../src/unifi/protect-api-events.js';
import { ProtectTlsPinStore } from '../src/unifi/protect-tls-pin-store.js';
import { decodePacket } from '../src/unifi/index.js';
import { join } from 'node:path';
import { normalizeFingerprint } from '../src/unifi/protect-api-tls.js';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

describe('CircuitBreaker', () => {

  beforeEach(() => {

    vi.useFakeTimers();
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it('stays closed below the error limit', () => {

    const breaker = new CircuitBreaker(3, 1000);

    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.check()).toBe('closed');
    expect(breaker.isThrottled).toBe(false);
  });

  it('trips after repeated errors and clears after the retry interval', () => {

    const breaker = new CircuitBreaker(3, 300000);

    for(let i = 0; i < 3; i++) {

      breaker.recordFailure();
    }

    expect(breaker.check()).toBe('tripped');
    expect(breaker.isThrottled).toBe(true);

    // Still in the penalty box.
    vi.advanceTimersByTime(299999);
    expect(breaker.check()).toBe('open');

    // Out of the penalty box.
    vi.advanceTimersByTime(1);
    expect(breaker.check()).toBe('resumed');
    expect(breaker.isThrottled).toBe(false);
    expect(breaker.errorCount).toBe(0);
    expect(breaker.check()).toBe('closed');
  });

  it('resets the error count on success', () => {

    const breaker = new CircuitBreaker(2, 1000);

    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();

    expect(breaker.check()).toBe('closed');
    expect(breaker.isOverLimit).toBe(false);
  });
});

describe('decodePacket inflate cap', () => {

  // Encode a frame with an arbitrary raw payload.
  const encodeFrame = (type: number, payload: Buffer, deflated: boolean): Buffer => {

    const header = Buffer.alloc(8);

    header.writeUInt8(type, 0);
    header.writeUInt8(1, 1);
    header.writeUInt8(deflated ? 1 : 0, 2);
    header.writeUInt32BE(payload.length, 4);

    return Buffer.concat([ header, payload ]);
  };

  it('drops a packet whose payload inflates beyond the cap', async () => {

    const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const action = encodeFrame(1, zlib.deflateSync(Buffer.from(JSON.stringify({ action: 'update', id: 'x', modelKey: 'camera' }))), true);

    // A highly compressible payload that inflates to just over the cap.
    const bomb = encodeFrame(2, zlib.deflateSync(Buffer.alloc(EVENT_PACKET_MAX_INFLATED_SIZE + 1, 0x20)), true);

    await expect(decodePacket(log, Buffer.concat([ action, bomb ]))).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not be decompressed'), expect.stringContaining('exceeds'));
  });

  it('decodes a payload right at the cap', async () => {

    const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const action = encodeFrame(1, Buffer.from(JSON.stringify({ action: 'update', id: 'x', modelKey: 'camera' })), false);
    const json = JSON.stringify({ blob: 'a'.repeat(EVENT_PACKET_MAX_INFLATED_SIZE - 11) });
    const data = encodeFrame(2, zlib.deflateSync(Buffer.from(json)), true);

    expect(json.length).toBe(EVENT_PACKET_MAX_INFLATED_SIZE);
    await expect(decodePacket(log, Buffer.concat([ action, data ]))).resolves.not.toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('ProtectTlsPinStore', () => {

  let dir: string;
  const fingerprint = Array(32).fill('0A').join(':');

  beforeEach(() => {

    dir = mkdtempSync(join(tmpdir(), 'hbup-pins-'));
  });

  afterEach(() => {

    rmSync(dir, { force: true, recursive: true });
  });

  it('normalizes fingerprints', () => {

    expect(normalizeFingerprint(fingerprint.replace(/:/g, '').toLowerCase())).toBe(fingerprint);
    expect(normalizeFingerprint('not-a-fingerprint')).toBeUndefined();
  });

  it('persists pins per controller address', () => {

    const file = join(dir, 'pins.json');
    const store = new ProtectTlsPinStore(file);

    expect(store.get('1.2.3.4')).toBeUndefined();

    store.set('1.2.3.4', fingerprint);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '1.2.3.4': fingerprint });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // A fresh store reads it back, with addresses compared case-insensitively.
    const reloaded = new ProtectTlsPinStore(file);

    expect(reloaded.get(' 1.2.3.4 ')).toBe(fingerprint);
    expect(reloaded.get('5.6.7.8')).toBeUndefined();
  });

  it('reports and tolerates a corrupt file', () => {

    const file = join(dir, 'pins.json');
    const onError = vi.fn();

    writeFileSync(file, '{ not json');

    expect(new ProtectTlsPinStore(file, onError).get('1.2.3.4')).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Unable to parse'));
  });
});
