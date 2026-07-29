/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * websocket.ts: Minimal, dependency-free RFC 6455 WebSocket client built on Node's https module.
 */
import type net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { Nullable } from './util.js';

// WebSocket protocol opcodes.
const enum Opcode {

  CONTINUATION = 0x0,
  TEXT = 0x1,
  BINARY = 0x2,
  CLOSE = 0x8,
  PING = 0x9,
  PONG = 0xA
}

// The RFC 6455 handshake GUID.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Handshake timeout, in milliseconds.
const WS_HANDSHAKE_TIMEOUT = 10000;

// Default cap on the size of a single inbound message, in bytes. This guards against a buggy or hostile endpoint declaring an enormous frame length and driving
// unbounded memory allocation. 64 MiB comfortably exceeds anything the UniFi realtime events and livestream APIs send.
const WS_DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024;

// Options available when connecting a WebSocket.
export interface WebSocketClientOptions {

  headers?: Record<string, string>;
  maxPayload?: number;
  rejectUnauthorized?: boolean;
}

/**
 * A minimal RFC 6455 WebSocket client supporting the ws and wss URL schemes, including self-signed TLS endpoints. Emits `open`, `message`, `close`, and `error`
 * events. Text messages are delivered as strings and binary messages as Buffers. This provides the small client-side subset of the WebSocket protocol the
 * plugin needs without requiring an external dependency.
 */
export class WebSocketClient extends EventEmitter {

  // Connection states, mirroring the standard WebSocket readyState semantics.
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState: number;

  private buffer: Buffer;
  private closeTimer: Nullable<NodeJS.Timeout>;
  private fragments: Buffer[];
  private fragmentOpcode: number;
  private fragmentSize: number;
  private maxPayload: number;
  private request: Nullable<http.ClientRequest>;
  private socket: Nullable<net.Socket>;

  // Create a new WebSocket connection to a ws:// or wss:// URL and begin the opening handshake.
  constructor(url: string, options: WebSocketClientOptions = {}) {

    super();

    this.buffer = Buffer.alloc(0);
    this.closeTimer = null;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.maxPayload = options.maxPayload ?? WS_DEFAULT_MAX_PAYLOAD;
    this.readyState = WebSocketClient.CONNECTING;
    this.request = null;
    this.socket = null;

    this.connect(url, options);
  }

  // Execute the HTTP upgrade handshake that establishes the WebSocket connection.
  private connect(url: string, options: WebSocketClientOptions): void {

    const parsed = new URL(url);
    const isSecure = parsed.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');

    const requestFn = isSecure ? https.request : http.request;

    const req = requestFn({

      headers: {

        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        'Upgrade': 'websocket',
        ...options.headers,
      },
      host: parsed.hostname,
      method: 'GET',
      path: parsed.pathname + parsed.search,
      port: parsed.port ? parseInt(parsed.port) : (isSecure ? 443 : 80),
      rejectUnauthorized: options.rejectUnauthorized ?? true,
      timeout: WS_HANDSHAKE_TIMEOUT,
    });

    this.request = req;

    req.on('upgrade', (res, socket, head) => {

      // We've been closed while the handshake was in flight - discard the connection rather than resurrecting it.
      if(this.readyState !== WebSocketClient.CONNECTING) {

        socket.destroy();

        return;
      }

      // Validate the handshake per RFC 6455 - the server must echo back the hashed key.
      const expected = createHash('sha1').update(key + WS_GUID).digest('base64');

      if((res.statusCode !== 101) || (res.headers['sec-websocket-accept'] !== expected)) {

        socket.destroy();
        this.readyState = WebSocketClient.CLOSED;
        this.emitError(new Error('Invalid WebSocket handshake response from the server.'));
        this.emit('close');

        return;
      }

      this.socket = socket;
      this.readyState = WebSocketClient.OPEN;

      socket.setNoDelay(true);
      socket.setTimeout(0);

      socket.on('data', (data: Buffer) => this.processData(data));

      socket.on('error', (error: Error) => this.emitError(error));

      socket.on('close', () => {

        if(this.closeTimer) {

          clearTimeout(this.closeTimer);
          this.closeTimer = null;
        }

        this.readyState = WebSocketClient.CLOSED;
        this.emit('close');
      });

      this.emit('open');

      // Process any data that arrived alongside the handshake.
      if(head.length) {

        this.processData(head);
      }
    });

    req.on('response', (res) => {

      // The server refused to upgrade the connection.
      this.readyState = WebSocketClient.CLOSED;
      this.emitError(new Error('WebSocket upgrade refused by the server: HTTP ' + res.statusCode + '.'));
      this.emit('close');
      req.destroy();
    });

    req.on('timeout', () => req.destroy(new Error('WebSocket handshake timed out.')));

    req.on('error', (error: Error) => {

      // If the upgrade succeeded, errors are surfaced through the socket instead.
      if(this.readyState !== WebSocketClient.CONNECTING) {

        return;
      }

      this.readyState = WebSocketClient.CLOSED;
      this.emitError(error);
      this.emit('close');
    });

    req.end();
  }

  // Emit an error event, but only when someone is listening. EventEmitter throws on unhandled 'error' events, and a transport-level hiccup arriving after a
  // consumer has already detached its listeners (e.g. during a shutdown race) must never crash the process.
  private emitError(error: Error): void {

    if(this.listenerCount('error')) {

      this.emit('error', error);
    }
  }

  // Process inbound data from the server, decoding complete WebSocket frames as they arrive.
  private processData(data: Buffer): void {

    this.buffer = Buffer.concat([ this.buffer, data ]);

    for(;;) {

      // We need at least the two-byte frame header.
      if(this.buffer.length < 2) {

        return;
      }

      const isFinal = !!(this.buffer[0] & 0x80);
      const opcode = this.buffer[0] & 0x0F;
      const isMasked = !!(this.buffer[1] & 0x80);
      let payloadLength = this.buffer[1] & 0x7F;
      let offset = 2;

      // Decode the extended payload lengths.
      if(payloadLength === 126) {

        if(this.buffer.length < (offset + 2)) {

          return;
        }

        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if(payloadLength === 127) {

        if(this.buffer.length < (offset + 8)) {

          return;
        }

        payloadLength = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      // Enforce our payload size cap before we commit to buffering the frame. A frame this large is either a protocol violation or a hostile endpoint - either
      // way, we're done. We account for any partially assembled fragmented message as well so fragmentation can't be used to sidestep the cap.
      if((payloadLength > this.maxPayload) || ((this.fragmentSize + payloadLength) > this.maxPayload)) {

        this.emitError(new Error('WebSocket message exceeds the maximum allowed size of ' + this.maxPayload + ' bytes.'));
        this.terminate();

        return;
      }

      // Server-to-client frames aren't masked in practice, but decode the mask if present to be protocol-complete.
      let mask: Nullable<Buffer> = null;

      if(isMasked) {

        if(this.buffer.length < (offset + 4)) {

          return;
        }

        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      // Wait for the complete frame to arrive.
      if(this.buffer.length < (offset + payloadLength)) {

        return;
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));

      this.buffer = this.buffer.subarray(offset + payloadLength);

      if(mask) {

        for(let index = 0; index < payload.length; index++) {

          payload[index] ^= mask[index % 4];
        }
      }

      this.processFrame(opcode, payload, isFinal);
    }
  }

  // Handle a single decoded WebSocket frame, reassembling fragmented messages as needed.
  private processFrame(opcode: number, payload: Buffer, isFinal: boolean): void {

    switch(opcode) {

      case Opcode.CONTINUATION:

        this.fragments.push(payload);
        this.fragmentSize += payload.length;

        if(isFinal) {

          const message = Buffer.concat(this.fragments);

          this.fragments = [];
          this.fragmentSize = 0;
          this.emitMessage(this.fragmentOpcode, message);
        }

        break;

      case Opcode.TEXT:
      case Opcode.BINARY:

        if(!isFinal) {

          this.fragmentOpcode = opcode;
          this.fragments = [ payload ];
          this.fragmentSize = payload.length;

          break;
        }

        this.emitMessage(opcode, payload);

        break;

      case Opcode.CLOSE:

        // Acknowledge the close handshake if the server initiated it, and shut the connection down.
        if(this.readyState === WebSocketClient.OPEN) {

          this.sendFrame(Opcode.CLOSE, payload.subarray(0, 2));
        }

        this.readyState = WebSocketClient.CLOSING;
        this.socket?.end();

        break;

      case Opcode.PING:

        this.sendFrame(Opcode.PONG, payload);

        break;

      default:

        // Pong frames and unknown opcodes need no action.
        break;
    }
  }

  // Deliver a complete message to our listeners. Text messages are decoded to strings.
  private emitMessage(opcode: number, payload: Buffer): void {

    this.emit('message', (opcode === Opcode.TEXT) ? payload.toString('utf8') : payload);
  }

  // Encode and transmit a single client-to-server frame. Client frames are always masked per RFC 6455.
  private sendFrame(opcode: number, payload: Buffer): void {

    if(!this.socket || this.socket.destroyed) {

      return;
    }

    const mask = randomBytes(4);
    let lengthHeader;

    if(payload.length < 126) {

      lengthHeader = Buffer.from([ 0x80 | payload.length ]);
    } else if(payload.length < 65536) {

      lengthHeader = Buffer.alloc(3);
      lengthHeader[0] = 0x80 | 126;
      lengthHeader.writeUInt16BE(payload.length, 1);
    } else {

      lengthHeader = Buffer.alloc(9);
      lengthHeader[0] = 0x80 | 127;
      lengthHeader.writeBigUInt64BE(BigInt(payload.length), 1);
    }

    const masked = Buffer.from(payload);

    for(let index = 0; index < masked.length; index++) {

      masked[index] ^= mask[index % 4];
    }

    this.socket.write(Buffer.concat([ Buffer.from([ 0x80 | opcode ]), lengthHeader, mask, masked ]));
  }

  // Send a message to the server. Strings are sent as text frames and Buffers as binary frames.
  public send(data: string | Buffer): void {

    if(this.readyState !== WebSocketClient.OPEN) {

      return;
    }

    if(typeof data === 'string') {

      this.sendFrame(Opcode.TEXT, Buffer.from(data, 'utf8'));

      return;
    }

    this.sendFrame(Opcode.BINARY, data);
  }

  // Initiate a graceful close of the connection, falling back to destroying the socket if the server doesn't complete the close handshake promptly.
  public close(): void {

    if((this.readyState === WebSocketClient.CLOSING) || (this.readyState === WebSocketClient.CLOSED)) {

      return;
    }

    // The handshake hasn't completed yet - abort the in-flight upgrade request so the connection can't complete and leak after we're closed.
    if(this.readyState === WebSocketClient.CONNECTING) {

      this.readyState = WebSocketClient.CLOSED;
      this.request?.destroy();
      this.emit('close');

      return;
    }

    const closePayload = Buffer.alloc(2);

    closePayload.writeUInt16BE(1000, 0);

    this.sendFrame(Opcode.CLOSE, closePayload);
    this.readyState = WebSocketClient.CLOSING;

    // Give the server a moment to complete the close handshake before we force the issue.
    this.closeTimer = setTimeout(() => this.socket?.destroy(), 1000);
  }

  // Immediately terminate the connection.
  public terminate(): void {

    const wasConnecting = this.readyState === WebSocketClient.CONNECTING;

    this.readyState = WebSocketClient.CLOSED;
    this.request?.destroy();
    this.socket?.destroy();

    // A socket that never existed can't emit the close event for us.
    if(wasConnecting) {

      this.emit('close');
    }
  }
}
