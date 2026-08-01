/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * lib-websocket.test.ts: Tests for the dependency-free RFC 6455 WebSocket client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketClient } from '../src/lib/websocket.js';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Encode a server-to-client WebSocket frame (unmasked, as servers send them).
function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {

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
function decodeClientFrames(buffer: Buffer): { isMasked: boolean; opcode: number; payload: Buffer }[] {

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

    frames.push({ isMasked, opcode, payload });
    offset = position + length;
  }

  return frames;
}

describe('WebSocketClient', () => {

  let server: http.Server;
  let url: string;
  let serverSockets: Socket[];
  let serverInbound: Buffer;
  let lastRequestHeaders: http.IncomingHttpHeaders;
  let clients: WebSocketClient[];

  // Server behavior toggles, reset per-test.
  let corruptAccept = false;
  let onUpgraded: ((socket: Socket) => void) | null = null;

  beforeAll(async () => {

    server = http.createServer((_req, res) => {

      // A non-upgrade response exercises the refusal path.
      res.statusCode = 403;
      res.end();
    });

    server.on('upgrade', (req, socket) => {

      lastRequestHeaders = req.headers;
      serverSockets.push(socket);

      const accept = createHash('sha1').update((req.headers['sec-websocket-key'] ?? '') + WS_GUID).digest('base64');

      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        (corruptAccept ? 'bogus' : accept) + '\r\n\r\n');

      socket.on('data', (data: Buffer) => {

        serverInbound = Buffer.concat([ serverInbound, data ]);
      });

      onUpgraded?.(socket);
    });

    await new Promise<void>(resolve => server.listen(0, resolve));

    url = 'ws://localhost:' + (server.address() as AddressInfo).port + '/events';
  });

  afterAll(() => server.close());

  beforeEach(() => {

    clients = [];
    serverSockets = [];
    serverInbound = Buffer.alloc(0);
    corruptAccept = false;
    onUpgraded = null;
  });

  afterEach(() => {

    // Tear down every connection, swallowing the stray error events that surface when we destroy sockets out from under the client.
    for(const ws of clients) {

      ws.on('error', () => {});
      ws.terminate();
    }

    for(const socket of serverSockets) {

      socket.destroy();
    }
  });

  // Create a client and wait for the connection to open.
  const connect = async (options = {}): Promise<WebSocketClient> => {

    const ws = new WebSocketClient(url, options);

    clients.push(ws);

    await once(ws, 'open');

    return ws;
  };

  it('completes the opening handshake and passes custom headers', async () => {

    const ws = await connect({ headers: { Cookie: 'TOKEN=abc' } });

    expect(ws.readyState).toBe(WebSocketClient.OPEN);
    expect(lastRequestHeaders.cookie).toBe('TOKEN=abc');
    expect(lastRequestHeaders.upgrade).toBe('websocket');
  });

  it('rejects a handshake with an invalid accept key', async () => {

    corruptAccept = true;

    const ws = new WebSocketClient(url);

    clients.push(ws);

    const [ error ] = await once(ws, 'error') as [ Error ];

    expect(error.message).toContain('handshake');
    expect(ws.readyState).toBe(WebSocketClient.CLOSED);
  });

  it('surfaces a refused upgrade as an error', async () => {

    // A server that answers the upgrade request with a plain HTTP response instead of switching protocols.
    const refusingServer = net.createServer(socket => {

      socket.on('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
    });

    await new Promise<void>(resolve => refusingServer.listen(0, resolve));

    const port = (refusingServer.address() as AddressInfo).port;
    const ws = new WebSocketClient('ws://localhost:' + port + '/');

    clients.push(ws);

    // Direct HTTP responses (no upgrade) must surface as an error, not a hang.
    const [ error ] = await once(ws, 'error') as [ Error ];

    refusingServer.close();

    expect(error.message).toContain('refused');
    expect(error.message).toContain('403');
  });

  it('delivers text, binary, jumbo, and fragmented messages', async () => {

    const messages: (string | Buffer)[] = [];
    const jumbo = Buffer.alloc(70000, 9);

    onUpgraded = (socket): void => {

      socket.write(encodeFrame(0x1, Buffer.from('hello')));
      socket.write(encodeFrame(0x2, Buffer.alloc(300, 7)));
      socket.write(encodeFrame(0x2, jumbo));
      socket.write(encodeFrame(0x1, Buffer.from('frag'), false));
      socket.write(encodeFrame(0x0, Buffer.from('mented')));
    };

    // Attach the message listener at construction, exactly as production code does - frames can arrive together with the handshake response.
    const ws = new WebSocketClient(url);

    clients.push(ws);
    ws.on('message', (message: string | Buffer) => messages.push(message));

    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(4));

    expect(messages[0]).toBe('hello');
    expect(messages[1]).toEqual(Buffer.alloc(300, 7));
    expect(messages[2]).toEqual(jumbo);
    expect(messages[3]).toBe('fragmented');
  });

  it('answers pings with pongs and masks all client frames', async () => {

    onUpgraded = (socket): void => {

      socket.write(encodeFrame(0x9, Buffer.from('pingpayload')));
    };

    const ws = await connect();

    ws.send('client-hello');
    ws.send(Buffer.from([ 1, 2, 3 ]));

    await vi.waitFor(() => expect(decodeClientFrames(serverInbound).length).toBeGreaterThanOrEqual(3));

    const frames = decodeClientFrames(serverInbound);

    const pong = frames.find(frame => frame.opcode === 0xA);
    const text = frames.find(frame => frame.opcode === 0x1);
    const binary = frames.find(frame => frame.opcode === 0x2);

    expect(pong?.payload.toString()).toBe('pingpayload');
    expect(text?.payload.toString()).toBe('client-hello');
    expect(binary?.payload).toEqual(Buffer.from([ 1, 2, 3 ]));

    // Every client-to-server frame must be masked - an unmasked client frame is an RFC 6455 violation that servers are required to reject.
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.every(frame => frame.isMasked)).toBe(true);
  });

  it('sends heartbeat pings and stays connected while the server answers', async () => {

    // Answer every inbound frame with a pong so the connection stays live across heartbeat intervals.
    onUpgraded = (socket): void => {

      socket.on('data', () => socket.write(encodeFrame(0xA, Buffer.alloc(0))));
    };

    const ws = await connect({ heartbeatInterval: 100 });

    // Wait for multiple heartbeat pings to hit the wire - the pongs they elicit keep the watchdog satisfied.
    await vi.waitFor(() => expect(decodeClientFrames(serverInbound).filter(frame => frame.opcode === 0x9).length).toBeGreaterThanOrEqual(2), { timeout: 2000 });

    expect(ws.readyState).toBe(WebSocketClient.OPEN);
  });

  it('detects a dead peer through the heartbeat and closes the connection', async () => {

    // The server never sends a frame after the handshake, so the heartbeat watchdog must declare the connection dead and close it.
    const ws = await connect({ heartbeatInterval: 100 });

    await once(ws, 'close');

    expect(ws.readyState).toBe(WebSocketClient.CLOSED);

    // The watchdog pinged the peer before giving up on it.
    expect(decodeClientFrames(serverInbound).some(frame => frame.opcode === 0x9)).toBe(true);
  });

  it('completes a client-initiated close handshake when the server echoes the close', async () => {

    // Echo the client's close frame back, completing the handshake, then finish the TCP shutdown.
    onUpgraded = (socket): void => {

      let inbound = Buffer.alloc(0);

      socket.on('data', (data: Buffer) => {

        inbound = Buffer.concat([ inbound, data ]);

        const close = decodeClientFrames(inbound).find(frame => frame.opcode === 0x8);

        if(close) {

          socket.write(encodeFrame(0x8, close.payload));
          socket.end();
        }
      });
    };

    const ws = await connect();

    const closed = once(ws, 'close');

    ws.close();

    await closed;

    expect(ws.readyState).toBe(WebSocketClient.CLOSED);

    // The client must have sent a close frame carrying the normal closure code.
    const clientClose = decodeClientFrames(serverInbound).find(frame => frame.opcode === 0x8);

    expect(clientClose?.payload.readUInt16BE(0)).toBe(1000);
  });

  it('falls back to destroying the socket when the server never completes the close handshake', async () => {

    const ws = await connect();

    const closed = once(ws, 'close');

    // The mock server never echoes the close frame, so the client must force the close via its fallback timer rather than hanging in CLOSING.
    ws.close();

    await closed;

    expect(ws.readyState).toBe(WebSocketClient.CLOSED);
  });

  it('acknowledges and completes a server-initiated close handshake', async () => {

    onUpgraded = (socket): void => {

      const payload = Buffer.alloc(2);

      payload.writeUInt16BE(1000, 0);
      socket.write(encodeFrame(0x8, payload));
      socket.end();
    };

    const ws = new WebSocketClient(url);

    clients.push(ws);

    await once(ws, 'close');

    expect(ws.readyState).toBe(WebSocketClient.CLOSED);

    // The client must have echoed the close frame back to the server.
    const clientClose = decodeClientFrames(serverInbound).find(frame => frame.opcode === 0x8);

    expect(clientClose?.payload.readUInt16BE(0)).toBe(1000);
  });

  it('enforces the maximum payload cap', async () => {

    onUpgraded = (socket): void => {

      socket.write(encodeFrame(0x2, Buffer.alloc(2048)));
    };

    // The error listener attaches at construction - the oversized frame can arrive together with the handshake response.
    const ws = new WebSocketClient(url, { maxPayload: 1024 });

    clients.push(ws);

    const [ error ] = await once(ws, 'error') as [ Error ];

    expect(error.message).toContain('maximum allowed size');
    expect(ws.readyState).toBe(WebSocketClient.CLOSED);
  });

  it('enforces the payload cap across fragmented messages', async () => {

    onUpgraded = (socket): void => {

      // Two fragments, each under the cap, that combine to exceed it.
      socket.write(encodeFrame(0x2, Buffer.alloc(700), false));
      socket.write(encodeFrame(0x0, Buffer.alloc(700)));
    };

    const ws = new WebSocketClient(url, { maxPayload: 1024 });

    clients.push(ws);

    const [ error ] = await once(ws, 'error') as [ Error ];

    expect(error.message).toContain('maximum allowed size');
  });

  it('does not count interleaved control frames against the fragmented message cap', async () => {

    const messages: (string | Buffer)[] = [];

    onUpgraded = (socket): void => {

      // A ping arriving between fragments must not contribute to the fragmented message's size accounting - 60 + 50 would breach the 100-byte cap.
      socket.write(encodeFrame(0x1, Buffer.alloc(60, 97), false));
      socket.write(encodeFrame(0x9, Buffer.alloc(50, 98)));
      socket.write(encodeFrame(0x0, Buffer.alloc(30, 99)));
    };

    const ws = new WebSocketClient(url, { maxPayload: 100 });

    clients.push(ws);
    ws.on('message', (message: string | Buffer) => messages.push(message));
    ws.on('error', () => {});

    await vi.waitFor(() => expect(messages.length).toBe(1));

    expect(messages[0]).toBe('a'.repeat(60) + 'c'.repeat(30));
    expect(ws.readyState).toBe(WebSocketClient.OPEN);
  });

  it('fails the connection on a continuation frame with no message in progress', async () => {

    onUpgraded = (socket): void => {

      socket.write(encodeFrame(0x0, Buffer.from('orphan')));
    };

    const ws = new WebSocketClient(url);

    clients.push(ws);

    const [ error ] = await once(ws, 'error') as [ Error ];

    expect(error.message).toContain('continuation');
    expect(ws.readyState).toBe(WebSocketClient.CLOSED);
  });

  it('drops an unfinished fragmented message when a new data frame arrives', async () => {

    const messages: (string | Buffer)[] = [];

    onUpgraded = (socket): void => {

      // An unfinished fragmented message interrupted by a self-contained frame - the stale fragments must not leak into any delivered message.
      socket.write(encodeFrame(0x1, Buffer.from('stale'), false));
      socket.write(encodeFrame(0x1, Buffer.from('fresh')));
    };

    const ws = new WebSocketClient(url);

    clients.push(ws);
    ws.on('message', (message: string | Buffer) => messages.push(message));

    await vi.waitFor(() => expect(messages.length).toBe(1));

    expect(messages[0]).toBe('fresh');
  });
});
