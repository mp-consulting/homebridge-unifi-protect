/* Copyright(C) 2022-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * livestream-protocol.test.ts: Tests for the UniFi Protect livestream API binary protocol client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo, Socket } from 'node:net';
import type { LivestreamOptions } from '../src/unifi/protect-api-livestream.js';
import type { ProtectApi } from '../src/unifi/protect-api.js';
import { ProtectLivestream } from '../src/unifi/protect-api-livestream.js';
import type { ProtectLogging } from '../src/unifi/protect-logging.js';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// The livestream packet type bytes, mirroring the ProtectLiveFrame enum in src/unifi/protect-api-livestream.ts.
const FRAME = {

  AUDIO: 253,
  BEGINSEGMENT: 249,
  CODECINFORMATION: 248,
  ENDSEGMENT: 255,
  INITSEGMENT: 250,
  MDAT: 254,
  MOOF: 251,
  TIMESTAMP: 247,
  VIDEO: 252,
} as const;

// Encode a server-to-client WebSocket frame (unmasked, as servers send them).
function encodeWsFrame(opcode: number, payload: Buffer, fin = true): Buffer {

  const finBit = fin ? 0x80 : 0;
  let header;

  if(payload.length < 126) {

    header = Buffer.from([ finBit | opcode, payload.length ]);
  } else if(payload.length < 65536) {

    header = Buffer.alloc(4);
    header[0] = finBit | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {

    header = Buffer.alloc(10);
    header[0] = finBit | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([ header, payload ]);
}

// Decode masked client-to-server frames from a raw stream buffer.
function decodeClientFrames(buffer: Buffer): { opcode: number; payload: Buffer }[] {

  const frames = [];
  let offset = 0;

  while((offset + 2) <= buffer.length) {

    const opcode = buffer[offset] & 0x0F;
    const isMasked = !!(buffer[offset + 1] & 0x80);
    let length = buffer[offset + 1] & 0x7F;
    let position = offset + 2;

    if(length === 126) {

      length = buffer.readUInt16BE(position);
      position += 2;
    } else if(length === 127) {

      length = Number(buffer.readBigUInt64BE(position));
      position += 8;
    }

    let mask = null;

    if(isMasked) {

      mask = buffer.subarray(position, position + 4);
      position += 4;
    }

    if((position + length) > buffer.length) {

      break;
    }

    const payload = Buffer.from(buffer.subarray(position, position + length));

    if(mask) {

      for(let index = 0; index < payload.length; index++) {

        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({ opcode, payload });
    offset = position + length;
  }

  return frames;
}

// Encode a single livestream protocol packet: a one-byte packet type followed by a three-byte big-endian payload length and the payload itself.
function livePacket(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {

  const header = Buffer.alloc(4);

  header.writeUInt8(type, 0);
  header.writeUIntBE(payload.length, 1, 3);

  return Buffer.concat([ header, payload ]);
}

// A single upgraded livestream connection as seen from the server side.
interface ServerConnection {

  echoClose: boolean;
  sawClientClose: boolean;
  socket: Socket;

  // Send one or more livestream packets to the client as a single binary WebSocket message.
  sendPackets: (...packets: Buffer[]) => void;
}

describe('ProtectLivestream', () => {

  let server: http.Server;
  let url: string;
  let connections: ServerConnection[];
  let pendingUpgrades: ((conn: ServerConnection) => void)[];
  let livestreams: ProtectLivestream[];
  let log: ProtectLogging;

  beforeAll(async () => {

    server = http.createServer((_req, res) => {

      res.statusCode = 403;
      res.end();
    });

    server.on('upgrade', (req, socket) => {

      const accept = createHash('sha1').update((req.headers['sec-websocket-key'] ?? '') + WS_GUID).digest('base64');

      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

      const conn: ServerConnection = {

        echoClose: true,
        sawClientClose: false,

        sendPackets: (...packets: Buffer[]): void => {

          if(!socket.writableEnded && !socket.destroyed) {

            socket.write(encodeWsFrame(0x2, Buffer.concat(packets)));
          }
        },

        socket,
      };

      let inbound = Buffer.alloc(0);

      // Swallow socket errors so an abrupt client teardown can't crash the worker.
      socket.on('error', () => {});

      socket.on('data', (data: Buffer) => {

        inbound = Buffer.concat([ inbound, data ]);

        // Complete the closing handshake when the client initiates one, unless a test has asked us to leave the connection dangling.
        if(!conn.sawClientClose && decodeClientFrames(inbound).some(frame => frame.opcode === 0x8)) {

          conn.sawClientClose = true;

          if(conn.echoClose) {

            socket.write(encodeWsFrame(0x8, Buffer.from([ 0x03, 0xE8 ])));
            socket.end();
          }
        }
      });

      connections.push(conn);
      pendingUpgrades.shift()?.(conn);
    });

    await new Promise<void>(resolve => server.listen(0, resolve));

    url = 'ws://localhost:' + (server.address() as AddressInfo).port + '/livestream';
  });

  afterAll(() => server.close());

  beforeEach(() => {

    connections = [];
    pendingUpgrades = [];
    livestreams = [];
    log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {

    vi.useRealTimers();

    for(const livestream of livestreams) {

      livestream.stop();
    }

    // End server sockets gracefully with a FIN rather than destroying them. A destroy here sends an RST, and the client's WebSocketClient would emit an
    // unhandled error event - stop() has already removed every listener - crashing the worker.
    for(const conn of connections) {

      conn.socket.end();
    }
  });

  // Create a fake ProtectApi exposing the one method ProtectLivestream uses: getWsEndpoint.
  const createApi = (wsUrl: string | null): { api: ProtectApi; getWsEndpoint: ReturnType<typeof vi.fn> } => {

    const getWsEndpoint = vi.fn(() => Promise.resolve(wsUrl));

    return { api: { getWsEndpoint } as unknown as ProtectApi, getWsEndpoint };
  };

  // Start a livestream session against our synthetic server and hand back the livestream and its server-side connection.
  const startSession = async (options: Partial<LivestreamOptions> = {}): Promise<{ conn: ServerConnection; livestream: ProtectLivestream }> => {

    const { api } = createApi(url);
    const livestream = new ProtectLivestream(api, log);

    livestreams.push(livestream);

    const upgraded = new Promise<ServerConnection>(resolve => pendingUpgrades.push(resolve));

    expect(await livestream.start('cam123', 1, options)).toBe(true);

    return { conn: await upgraded, livestream };
  };

  // Record every emission of an event, capturing the first argument passed to listeners.
  const record = (livestream: ProtectLivestream, event: string): unknown[] => {

    const sink: unknown[] = [];

    livestream.on(event, (argument: unknown) => sink.push(argument));

    return sink;
  };

  it('requests the livestream endpoint with the expected parameters and fails cleanly without one', async () => {

    const { api, getWsEndpoint } = createApi(null);
    const livestream = new ProtectLivestream(api, log);

    livestreams.push(livestream);

    // A null websocket endpoint from the controller must fail the start and inform the user.
    expect(await livestream.start('cam123', 1, { emitTimestamps: true, segmentLength: 50 })).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('unable to retrieve the livestream websocket API endpoint'));

    const [ endpoint, params ] = getWsEndpoint.mock.calls[0] as [ string, URLSearchParams ];

    expect(endpoint).toBe('livestream');
    expect(params.get('camera')).toBe('cam123');
    expect(params.get('channel')).toBe('1');
    expect(params.get('chunkSize')).toBe('4096');

    // Segment lengths below 100ms are floored to 100ms.
    expect(params.get('fragmentDurationMillis')).toBe('100');
    expect(params.get('lens')).toBe('0');
    expect(params.get('requestId')).toBe('cam123-1');
    expect(params.get('type')).toBe('fmp4');
    expect(params.get('rebaseTimestampsToZero')).toBe('true');
    expect(params.has('extendedVideoMetadata')).toBe(true);
  });

  it('delivers the initialization segment and caches it', async () => {

    const { conn, livestream } = await startSession();

    const initEvents = record(livestream, 'initsegment');
    const messageEvents = record(livestream, 'message');

    // Request the initialization segment before it arrives so we exercise the pending-promise path.
    const pendingInit = livestream.getInitSegment();
    const initPayload = Buffer.from('ftypmoov-init-segment-payload');

    conn.sendPackets(livePacket(FRAME.INITSEGMENT, initPayload));

    expect(await pendingInit).toEqual(initPayload);

    expect(initEvents).toEqual([ initPayload ]);
    expect(messageEvents).toEqual([ initPayload ]);
    expect(livestream.initSegment).toEqual(initPayload);

    // Once cached, the initialization segment resolves immediately.
    expect(await livestream.getInitSegment()).toEqual(initPayload);
  });

  it('assembles a regular segment in moof, mdat, video, audio order', async () => {

    const { conn, livestream } = await startSession();

    const segmentEvents = record(livestream, 'segment');
    const messageEvents = record(livestream, 'message');
    const moofEvents = record(livestream, 'moof');
    const mdatEvents = record(livestream, 'mdat');

    const moof1 = Buffer.alloc(16, 1);
    const moof2 = Buffer.alloc(8, 2);
    const mdat = Buffer.alloc(32, 3);
    const video = Buffer.alloc(12, 4);
    const audio = Buffer.alloc(6, 5);

    // Send an entire segment sequence as a single websocket message, exercising multiple packets in one message.
    conn.sendPackets(
      livePacket(FRAME.BEGINSEGMENT),
      livePacket(FRAME.MOOF, moof1),
      livePacket(FRAME.MOOF, moof2),
      livePacket(FRAME.MDAT, mdat),
      livePacket(FRAME.VIDEO, video),
      livePacket(FRAME.AUDIO, audio),
      livePacket(FRAME.ENDSEGMENT),
    );

    await vi.waitFor(() => expect(segmentEvents.length).toBe(1));

    // The complete segment concatenates the accumulated boxes as moof, mdat, video, audio.
    const expected = Buffer.concat([ moof1, moof2, mdat, video, audio ]);

    expect(segmentEvents[0]).toEqual(expected);
    expect(messageEvents).toEqual([ expected ]);
    expect(moofEvents[0]).toEqual(Buffer.concat([ moof1, moof2 ]));
    expect(mdatEvents[0]).toEqual(mdat);
  });

  it('reassembles packets split across multiple websocket messages', async () => {

    const { conn, livestream } = await startSession();

    const initEvents = record(livestream, 'initsegment');
    const codecEvents = record(livestream, 'codec');

    const initPayload = Buffer.alloc(30, 0xAB);
    const packetA = livePacket(FRAME.INITSEGMENT, initPayload);
    const packetB = livePacket(FRAME.CODECINFORMATION, Buffer.from('avc1.640028,mp4a.40.2'));

    // Split mid-header (under the 4-byte minimum), then mid-payload, then complete packet A with a partial packet B, then finish packet B.
    conn.socket.write(encodeWsFrame(0x2, packetA.subarray(0, 2)));
    conn.socket.write(encodeWsFrame(0x2, packetA.subarray(2, 20)));
    conn.socket.write(encodeWsFrame(0x2, Buffer.concat([ packetA.subarray(20), packetB.subarray(0, 3) ])));
    conn.socket.write(encodeWsFrame(0x2, packetB.subarray(3)));

    await vi.waitFor(() => expect(codecEvents.length).toBe(1));

    expect(initEvents).toEqual([ initPayload ]);
    expect(codecEvents).toEqual([ 'avc1.640028,mp4a.40.2' ]);
  });

  it('emits codec information and exposes it through the codec accessor', async () => {

    const { conn, livestream } = await startSession();

    expect(livestream.codec).toBe('');

    const codecEvent = once(livestream, 'codec');

    conn.sendPackets(livePacket(FRAME.CODECINFORMATION, Buffer.from('hev1.1.6.L150,mp4a.40.2')));

    expect((await codecEvent)[0]).toBe('hev1.1.6.L150,mp4a.40.2');
    expect(livestream.codec).toBe('hev1.1.6.L150,mp4a.40.2');
  });

  it('emits decode timestamps as an array of numbers', async () => {

    const { conn, livestream } = await startSession();

    const timestampEvent = once(livestream, 'timestamps');
    const payload = Buffer.alloc(16);

    payload.writeBigUInt64BE(90000n, 0);
    payload.writeBigUInt64BE(180000n, 8);

    conn.sendPackets(livePacket(FRAME.TIMESTAMP, payload));

    expect((await timestampEvent)[0]).toEqual([ 90000, 180000 ]);
  });

  it('logs an error on an invalid packet header and recovers on the next message', async () => {

    const { conn, livestream } = await startSession();

    const codecEvents = record(livestream, 'codec');

    // Packet type 42 isn't a valid livestream frame type.
    conn.sendPackets(livePacket(42, Buffer.from('garbage')));

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid header'), 42));

    // A subsequent, well-formed message must still be processed.
    conn.sendPackets(livePacket(FRAME.CODECINFORMATION, Buffer.from('avc1,mp4a')));

    await vi.waitFor(() => expect(codecEvents).toEqual([ 'avc1,mp4a' ]));
  });

  it('a manual stop closes the websocket without emitting close and suppresses further events', async () => {

    const { conn, livestream } = await startSession();

    // Wait for a first roundtrip so we know the client-side handshake has fully completed. Stopping while the WebSocket is still connecting never sends a
    // close frame - close() on a CONNECTING WebSocketClient simply marks it closed.
    const codecEvent = once(livestream, 'codec');

    conn.sendPackets(livePacket(FRAME.CODECINFORMATION, Buffer.from('avc1,mp4a')));

    await codecEvent;

    // Leave the connection dangling server-side so we can prove the client ignores post-stop traffic.
    conn.echoClose = false;

    const closeEvents = record(livestream, 'close');
    const messageEvents = record(livestream, 'message');

    livestream.stop();

    // The client must have initiated the closing handshake.
    await vi.waitFor(() => expect(conn.sawClientClose).toBe(true));

    // Traffic arriving after a manual stop must not surface as events.
    conn.sendPackets(livePacket(FRAME.INITSEGMENT, Buffer.from('late-init')));

    await new Promise(resolve => setTimeout(resolve, 150));

    expect(messageEvents.length).toBe(0);
    expect(closeEvents.length).toBe(0);
    expect(livestream.initSegment).toBeNull();
  });

  it('a server-initiated close emits close and rejects a pending init segment request', async () => {

    const { conn, livestream } = await startSession();

    const closeEvent = once(livestream, 'close');
    const pendingInit = livestream.getInitSegment();

    // Attach a rejection handler up front so the abort can't surface as an unhandled rejection.
    pendingInit.catch(() => {});

    // Close the connection from the server side: a close frame followed by ending the socket.
    conn.socket.write(encodeWsFrame(0x8, Buffer.from([ 0x03, 0xE8 ])));
    conn.socket.end();

    await closeEvent;

    await expect(pendingInit).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a pending init segment request when stopped and refuses one without a session', async () => {

    const { livestream } = await startSession();

    const pendingInit = livestream.getInitSegment();

    pendingInit.catch(() => {});

    livestream.stop();

    await expect(pendingInit).rejects.toMatchObject({ name: 'AbortError' });

    // With no session ever started, there's nothing that can produce an initialization segment. Note that we need a fresh instance here: after a stop(), the
    // cached (and now aborted) init segment promise is returned instead, since only start() clears the cache.
    const neverStarted = new ProtectLivestream(createApi(url).api, log);

    await expect(neverStarted.getInitSegment()).rejects.toThrow('No active livestream session.');
  });

  it('pushes segments through a Readable stream instead of events when useStream is set', async () => {

    const { conn, livestream } = await startSession({ useStream: true });

    const stream = livestream.stream as Readable;

    expect(stream).not.toBeNull();

    const chunks: Buffer[] = [];
    let ended = false;

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {

      ended = true;
    });

    const initEvents = record(livestream, 'initsegment');
    const codecEvents = record(livestream, 'codec');
    const messageEvents = record(livestream, 'message');

    const initPayload = Buffer.from('stream-init');
    const moof = Buffer.alloc(10, 7);
    const mdat = Buffer.alloc(20, 8);

    conn.sendPackets(
      livePacket(FRAME.CODECINFORMATION, Buffer.from('avc1,mp4a')),
      livePacket(FRAME.INITSEGMENT, initPayload),
      livePacket(FRAME.BEGINSEGMENT),
      livePacket(FRAME.MOOF, moof),
      livePacket(FRAME.MDAT, mdat),
      livePacket(FRAME.ENDSEGMENT),
    );

    await vi.waitFor(() => expect(chunks.length).toBe(2));

    expect(chunks[0]).toEqual(initPayload);
    expect(chunks[1]).toEqual(Buffer.concat([ moof, mdat ]));

    // In stream mode, segment and codec events are suppressed, but the codec accessor still works.
    expect(initEvents.length).toBe(0);
    expect(codecEvents.length).toBe(0);
    expect(messageEvents.length).toBe(0);
    expect(livestream.codec).toBe('avc1,mp4a');

    // Stopping the livestream ends the stream gracefully.
    livestream.stop();

    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it('tears down an unresponsive livestream via the heartbeat watchdog', async () => {

    // Fake only the interval timer driving the heartbeat and the Date it consults, so we can fast-forward. Socket I/O stays real.
    vi.useFakeTimers({ toFake: [ 'setInterval', 'Date' ] });

    const { conn, livestream } = await startSession();

    // A first message anchors the heartbeat's last-seen time at the current fake clock.
    const codecEvent = once(livestream, 'codec');

    conn.sendPackets(livePacket(FRAME.CODECINFORMATION, Buffer.from('avc1,mp4a')));

    await codecEvent;

    const closeEvent = once(livestream, 'close');

    // The first heartbeat check sees exactly the timeout elapsed, which isn't enough. The second check crosses it and closes the connection.
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10000);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('the livestream API is not responding.'));

    // The watchdog-initiated close completes the closing handshake with the server and surfaces as a close event.
    await closeEvent;

    expect(conn.sawClientClose).toBe(true);
  });
});
