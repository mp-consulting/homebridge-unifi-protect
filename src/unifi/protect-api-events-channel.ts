/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api-events-channel.ts: Realtime update events WebSocket for the UniFi Protect API.
 */
import type { Nullable } from './protect-types.js';
import type { ProtectEventPacket } from './protect-api-events.js';
import type { ProtectLogging } from './protect-logging.js';
import { WebSocketClient } from '../lib/websocket.js';
import { decodePacket } from './protect-api-events.js';
import type https from 'node:https';
import util from 'node:util';

// Heartbeat interval, in milliseconds, for the realtime events WebSocket. If no traffic is seen within this interval, the connection is presumed dead and torn
// down so it can be reestablished.
const PROTECT_EVENTS_HEARTBEAT_INTERVAL = 30000;

// Delay, in milliseconds, before attempting to reconnect the realtime events WebSocket after it closes. This shrinks the event blackout that would otherwise
// last until the next periodic bootstrap refresh.
const PROTECT_EVENTS_RECONNECT_DELAY = 5000;

/**
 * What the events channel needs from the API client that owns it.
 *
 * @internal
 */
export interface ProtectEventsChannelHost {

  cookie: () => string | undefined;
  emitMessage: (packet: ProtectEventPacket) => void;
  isLoggedIn: () => boolean;
  lastUpdateId: () => string;
  log: ProtectLogging;
  login: () => Promise<boolean>;
  nvrAddress: () => string;
  tlsAgent: () => https.Agent;
  verifyTls: () => boolean;
}

/**
 * The realtime update events WebSocket, including heartbeat-based dead connection detection, ordered packet delivery, and automatic reconnection.
 *
 * @internal
 */
export class ProtectEventsChannel {

  private readonly host: ProtectEventsChannelHost;
  private reconnectTimer: Nullable<NodeJS.Timeout>;
  private ws: Nullable<WebSocketClient>;

  constructor(host: ProtectEventsChannelHost) {

    this.host = host;
    this.reconnectTimer = null;
    this.ws = null;
  }

  // Connect to the realtime update events API.
  public async connect(): Promise<boolean> {

    // Log us in if needed.
    if(!(await this.host.login())) {

      return false;
    }

    // If we already have a listener, we're already all set.
    if(this.ws) {

      return true;
    }

    // Launch the realtime events WebSocket. We need to hand it the last update ID we know about in order
    // to ensure we don't miss any actual updates since we last pulled the bootstrap configuration.
    const params = new URLSearchParams({ lastUpdateId: this.host.lastUpdateId() });

    try {

      // Let's open the WebSocket connection, passing our authentication cookie. We connect through the API's TLS agent so the controller's certificate is
      // checked against our pinned fingerprint (or fully validated when verifyTls is set) before the cookie is sent. The heartbeat detects connections that
      // die without a FIN or RST - without it, a silently dead socket would leave us listening forever on a connection that will never deliver another event.
      const ws = new WebSocketClient('wss://' + this.host.nvrAddress() + '/proxy/protect/ws/updates?' + params.toString(),
        { agent: this.host.tlsAgent(), headers: { Cookie: this.host.cookie() ?? '' }, heartbeatInterval: PROTECT_EVENTS_HEARTBEAT_INTERVAL,
          rejectUnauthorized: this.host.verifyTls() });

      // Handle any WebSocket errors. A single once handler covers both the connection phase and the post-connection lifetime...the first error on the WebSocket
      // triggers logging, closes the connection, and the close event handles cleanup.
      ws.once('error', (error: Error) => {

        this.host.log.error('Events API error: %s', error.message);
        this.host.log.error(util.inspect(error, { colors: true, depth: null, sorted: true }));
        ws.close();
      });

      // Wait for the WebSocket to actually connect before reporting success. This ensures we only signal success when both the HTTP bootstrap and the realtime
      // events channel are fully established. We use named handlers so that whichever fires first can remove the other, preventing stale listeners from
      // interfering with post-connection event handling.
      const connected = await new Promise<boolean>((resolve) => {

        function onOpen(): void {

          ws.off('close', onClose);
          resolve(true);
        }

        // If the connection fails, the error handler above will close the WebSocket. We listen for close to detect that the connection was never established.
        function onClose(): void {

          ws.off('open', onOpen);
          resolve(false);
        }

        ws.once('open', onOpen);
        ws.once('close', onClose);
      });

      // The WebSocket connection failed to establish.
      if(!connected) {

        return false;
      }

      // Make the WebSocket available.
      this.ws = ws;

      // Cleanup after ourselves if our WebSocket closes for some reason. We guard on identity - a delayed close event from a superseded socket must not null
      // out a newer live socket, which would otherwise allow duplicate concurrent event connections and doubled events.
      ws.once('close', () => {

        ws.removeAllListeners();

        if(this.ws !== ws) {

          return;
        }

        this.ws = null;

        // Schedule a single reconnect attempt if we're still logged in, rather than waiting for the next periodic bootstrap refresh to notice the outage. The
        // timer guard ensures overlapping close events can't stack reconnect attempts, and close() cancels any pending attempt.
        if(this.host.isLoggedIn() && !this.reconnectTimer) {

          this.reconnectTimer = setTimeout(() => {

            this.reconnectTimer = null;
            void this.connect();
          }, PROTECT_EVENTS_RECONNECT_DELAY);
        }
      });

      // Emit queue for ordered event delivery. Packet decoding is async (zlib inflate runs on the libuv threadpool), so multiple packets can be inflating
      // concurrently. We use .then() here deliberately - it's the right primitive for this pattern. Each message handler starts its decode immediately
      // (parallel inflate), then chains the emit onto the queue so packets are always emitted in arrival order. We can't use async/await for the chaining
      // because event handlers aren't awaited, and we want decodes to start immediately rather than waiting for prior packets to complete.
      let emitQueue = Promise.resolve();

      // Chain a decoded packet onto the emit queue. The .then() ensures packets are emitted in arrival order even if later packets finish inflating before
      // earlier ones. The .catch() prevents a single decode failure from poisoning the queue - without it, a rejected promise would cause all subsequent
      // .then() calls to also reject.
      const enqueuePacket = (decoded: Promise<Nullable<ProtectEventPacket>>): void => {

        emitQueue = emitQueue.then(async () => {

          const packet = await decoded;

          if(!packet) {

            this.host.log.error('Unable to process message from the realtime update events API.');
            ws.close();

            return;
          }

          this.host.emitMessage(packet);
        }).catch((error) => {

          this.host.log.error('Error processing events WebSocket message: %s.', error);
          ws.close();
        });
      };

      // Process messages as they come in. Our WebSocket client delivers binary frames as Buffers and text frames as strings, so we can normalize and start
      // decoding immediately. The inflate runs on the libuv threadpool in parallel with any other in-flight decodes.
      ws.on('message', (data: Buffer | string) => {

        enqueuePacket(decodePacket(this.host.log, Buffer.isBuffer(data) ? data : Buffer.from(data)));
      });
    } catch(error) {

      this.host.log.error('Error connecting to the realtime update events API: %s.', error);

      return false;
    }

    return true;
  }

  // Close the events WebSocket and cancel any pending reconnect attempt.
  public close(): void {

    // Detach the events WebSocket before closing it - close can emit synchronously, and the close handler must not see this socket as live or schedule a
    // reconnect attempt mid-close.
    const ws = this.ws;

    this.ws = null;
    ws?.close();

    // Cancel any pending events WebSocket reconnect attempt so a reset can't be undone by a stale timer.
    if(this.reconnectTimer) {

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
