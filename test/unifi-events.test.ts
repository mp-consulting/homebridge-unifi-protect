/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * unifi-events.test.ts: Tests for the UniFi Protect realtime events packet decoder.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodePacket } from '../src/unifi/index.js';
import zlib from 'node:zlib';

const silentLog = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

// Encode a single frame of a Protect realtime events packet: an eight-byte header (type, payload format, deflated flag, unknown, 32-bit payload size) followed
// by the payload itself.
function encodeFrame(type: number, data: unknown, deflate: boolean): Buffer {

  let payload = Buffer.from(JSON.stringify(data));

  if(deflate) {

    payload = zlib.deflateSync(payload);
  }

  const header = Buffer.alloc(8);

  header.writeUInt8(type, 0);
  header.writeUInt8(1, 1);
  header.writeUInt8(deflate ? 1 : 0, 2);
  header.writeUInt32BE(payload.length, 4);

  return Buffer.concat([ header, payload ]);
}

const action = { action: 'update', id: 'evt1', modelKey: 'camera', newUpdateId: 'update1' };
const data = { isMotionDetected: true, name: 'Front Door' };

describe('decodePacket', () => {

  it('decodes a deflated action/data packet', async () => {

    const packet = Buffer.concat([ encodeFrame(1, action, true), encodeFrame(2, data, true) ]);
    const decoded = await decodePacket(silentLog, packet);

    expect(decoded).not.toBeNull();
    expect(decoded?.header).toEqual(action);
    expect(decoded?.payload).toEqual(data);
  });

  it('decodes an uncompressed packet identically', async () => {

    const packet = Buffer.concat([ encodeFrame(1, action, false), encodeFrame(2, data, false) ]);
    const decoded = await decodePacket(silentLog, packet);

    expect(decoded?.header).toEqual(action);
    expect(decoded?.payload).toEqual(data);
  });

  it('returns null for a truncated packet', async () => {

    const log = { ...silentLog, error: vi.fn() };

    expect(await decodePacket(log, Buffer.from([ 1, 2, 3 ]))).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('returns null when the frame sizes are inconsistent', async () => {

    const packet = Buffer.concat([ encodeFrame(1, action, false), encodeFrame(2, data, false) ]);

    // Corrupt the first frame's declared payload size.
    packet.writeUInt32BE(packet.readUInt32BE(4) + 5, 4);

    expect(await decodePacket(silentLog, packet)).toBeNull();
  });

  it('returns null for garbage deflate data', async () => {

    const header = Buffer.alloc(8);

    header.writeUInt8(1, 0);
    header.writeUInt8(1, 1);
    header.writeUInt8(1, 2);
    header.writeUInt32BE(4, 4);

    const badFrame = Buffer.concat([ header, Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEF ]) ]);
    const packet = Buffer.concat([ badFrame, badFrame ]);

    expect(await decodePacket(silentLog, packet)).toBeNull();
  });
});
