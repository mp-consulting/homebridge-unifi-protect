/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * mqtt-connection.ts: Minimal, dependency-free MQTT 3.1.1 client over TCP and TLS.
 */
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Nullable } from './util.js';

// MQTT control packet types (upper nibble of the fixed header).
const enum PacketType {

  CONNECT = 0x10,
  CONNACK = 0x20,
  PUBLISH = 0x30,
  PUBACK = 0x40,
  SUBSCRIBE = 0x82,
  SUBACK = 0x90,
  UNSUBSCRIBE = 0xA2,
  UNSUBACK = 0xB0,
  PINGREQ = 0xC0,
  PINGRESP = 0xD0,
  DISCONNECT = 0xE0
}

// Keepalive interval, in seconds, that we advertise to the broker.
const MQTT_KEEPALIVE = 60;

// Handshake timeout, in milliseconds. A TCP endpoint that accepts our connection but never completes the MQTT handshake would otherwise hang us forever, since
// the keepalive watchdog is only armed once CONNACK arrives.
const MQTT_CONNECT_TIMEOUT = 10000;

// The largest broker-declared packet we're willing to buffer. Our use case is small command and telemetry payloads - anything approaching this size is a broken
// or hostile peer, and buffering the protocol maximum of 256 MB would be an easy way to exhaust memory on small Homebridge hosts.
const MQTT_MAX_PACKET_SIZE = 16 * 1024 * 1024;

// Options to configure the MQTT connection.
export interface MqttConnectionOptions {

  reconnectPeriod?: number;
  rejectUnauthorized?: boolean;
}

// Encode an MQTT UTF-8 string: a two-byte big-endian length prefix followed by the string.
function encodeString(value: string): Buffer {

  const payload = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);

  length.writeUInt16BE(payload.length, 0);

  return Buffer.concat([ length, payload ]);
}

// Encode the MQTT remaining length field as a variable-length integer.
function encodeLength(length: number): Buffer {

  const bytes = [];

  do {

    let byte = length % 128;

    length = Math.floor(length / 128);

    if(length > 0) {

      byte |= 0x80;
    }

    bytes.push(byte);
  } while(length > 0);

  return Buffer.from(bytes);
}

/**
 * A minimal MQTT 3.1.1 client supporting QoS 0 publish and subscribe over mqtt://, mqtts://, tcp://, and ssl:// broker URLs, with automatic reconnection and
 * resubscription. This provides the small subset of the MQTT protocol that the plugin needs without requiring an external dependency.
 */
export class MqttConnection extends EventEmitter {

  private buffer: Buffer;
  private connected: boolean;
  private connectTimer: Nullable<NodeJS.Timeout>;
  private ended: boolean;
  private host: string;
  private keepaliveTimer: Nullable<NodeJS.Timeout>;
  private packetId: number;
  private pendingPings: number;
  private password?: string;
  private port: number;
  private queuedPackets: { body: Buffer; type: PacketType }[];
  private reconnectPeriod: number;
  private reconnectTimer: Nullable<NodeJS.Timeout>;
  private rejectUnauthorized: boolean;
  private socket: Nullable<net.Socket>;
  private subscribedTopics: Set<string>;
  private useTls: boolean;
  private username?: string;

  // Create a new MQTT connection to a broker URL and initiate the first connection attempt.
  constructor(brokerUrl: string, options: MqttConnectionOptions = {}) {

    super();

    let url;

    // Validate the broker URL, mirroring the error semantics callers expect for malformed URLs.
    try {

      url = new URL(brokerUrl);
    } catch(error) {

      throw new Error('Missing protocol', { cause: error });
    }

    const protocol = url.protocol.replace(':', '');

    // We support TCP and TLS transports only. Notably, MQTT-over-WebSocket (ws:// and wss://) URLs are not supported - give those a distinct error so callers
    // can explain the limitation rather than reporting the URL as malformed.
    if(!['mqtt', 'mqtts', 'ssl', 'tcp'].includes(protocol)) {

      throw new Error('Unsupported protocol: ' + protocol);
    }

    this.useTls = ['mqtts', 'ssl'].includes(protocol);
    this.host = url.hostname;
    this.port = url.port ? parseInt(url.port) : (this.useTls ? 8883 : 1883);
    this.username = url.username ? decodeURIComponent(url.username) : undefined;
    this.password = url.password ? decodeURIComponent(url.password) : undefined;

    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.connectTimer = null;
    this.ended = false;
    this.keepaliveTimer = null;
    this.packetId = 0;
    this.pendingPings = 0;
    this.queuedPackets = [];
    this.reconnectPeriod = options.reconnectPeriod ?? 60000;
    this.reconnectTimer = null;
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.socket = null;
    this.subscribedTopics = new Set();

    this.open();
  }

  // Open a connection to the broker and send our CONNECT packet.
  private open(): void {

    // We've been shutdown, we're done.
    if(this.ended) {

      return;
    }

    const onConnect = (): void => this.sendConnect();

    // Create the transport socket, with TLS if requested.
    const socket = this.useTls ?
      tls.connect({ host: this.host, port: this.port, rejectUnauthorized: this.rejectUnauthorized }, onConnect) :
      net.connect({ host: this.host, port: this.port }, onConnect);

    this.socket = socket;
    this.buffer = Buffer.alloc(0);

    // Guard the connection handshake with a timeout covering both the transport connection and the broker's CONNACK. Without it, an endpoint that accepts our
    // TCP connection but never speaks MQTT would leave us hung forever, since the keepalive watchdog is only armed once CONNACK arrives.
    this.connectTimer = setTimeout(() => {

      this.connectTimer = null;
      this.emitError(new Error('Timed out waiting for the MQTT broker to complete the connection handshake.'));
      socket.destroy();
    }, MQTT_CONNECT_TIMEOUT);

    socket.on('data', (data: Buffer) => this.processData(data));

    socket.on('error', (error: Error) => this.emitError(error));

    socket.on('close', () => {

      this.teardownSocket();
      this.emit('close');
      this.scheduleReconnect();
    });
  }

  // Send the MQTT CONNECT packet to the broker.
  private sendConnect(): void {

    // Assemble our connect flags: clean session, plus credentials if we have them.
    let flags = 0x02;

    if(this.username !== undefined) {

      flags |= 0x80;
    }

    if(this.password !== undefined) {

      flags |= 0x40;
    }

    const keepalive = Buffer.alloc(2);

    keepalive.writeUInt16BE(MQTT_KEEPALIVE, 0);

    // Variable header: protocol name, protocol level 4 (MQTT 3.1.1), connect flags, and keepalive.
    const variableHeader = Buffer.concat([ encodeString('MQTT'), Buffer.from([ 0x04, flags ]), keepalive ]);

    // Payload: client identifier, followed by the optional username and password.
    const payloadParts = [ encodeString('mqjs_' + randomBytes(4).toString('hex')) ];

    if(this.username !== undefined) {

      payloadParts.push(encodeString(this.username));
    }

    if(this.password !== undefined) {

      payloadParts.push(encodeString(this.password));
    }

    this.writePacket(PacketType.CONNECT, Buffer.concat([ variableHeader, ...payloadParts ]));
  }

  // Process inbound data from the broker, decoding complete MQTT packets as they arrive.
  private processData(data: Buffer): void {

    this.buffer = Buffer.concat([ this.buffer, data ]);

    for(;;) {

      // We need at least the fixed header byte and one length byte.
      if(this.buffer.length < 2) {

        return;
      }

      // Decode the remaining length varint.
      let length = 0;
      let multiplier = 1;
      let offset = 1;

      for(;;) {

        if(offset >= this.buffer.length) {

          return;
        }

        const byte = this.buffer[offset++];

        length += (byte & 0x7F) * multiplier;
        multiplier *= 128;

        if(!(byte & 0x80)) {

          break;
        }

        // Malformed length field - the varint can be at most four bytes.
        if(offset > 4) {

          this.socket?.destroy();

          return;
        }
      }

      // A packet this large is a broken or hostile peer - don't buffer it.
      if(length > MQTT_MAX_PACKET_SIZE) {

        this.emitError(new Error('Invalid MQTT packet received: declared packet length ' + length + ' exceeds the maximum of ' + MQTT_MAX_PACKET_SIZE + '.'));
        this.socket?.destroy();

        return;
      }

      // Wait for the complete packet to arrive.
      if(this.buffer.length < (offset + length)) {

        return;
      }

      const packet = this.buffer.subarray(offset, offset + length);

      this.processPacket(this.buffer[0], packet);
      this.buffer = this.buffer.subarray(offset + length);
    }
  }

  // Dispatch a single decoded MQTT packet.
  private processPacket(header: number, packet: Buffer): void {

    // Any complete packet from the broker - PINGRESP or otherwise - proves the connection is alive, so we reset our keepalive watchdog.
    this.pendingPings = 0;

    switch(header & 0xF0) {

      case PacketType.CONNACK & 0xF0:

        // Check the connect return code.
        if(packet[1] !== 0) {

          this.emitError(Object.assign(new Error('Connection refused by the MQTT broker: return code ' + packet[1] + '.'), { code: 'ECONNREFUSED' }));
          this.socket?.destroy();

          return;
        }

        // We're connected. Restore any subscriptions we had, start our keepalive heartbeat, and flush any packets that were queued while the handshake was in
        // flight. Queued SUBSCRIBEs never exist - subscriptions made before now are captured in subscribedTopics and covered by the restoration loop below.
        this.connected = true;

        if(this.connectTimer) {

          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }

        this.startKeepalive();

        for(const topic of this.subscribedTopics) {

          this.sendSubscribe(topic);
        }

        for(const queued of this.queuedPackets.splice(0)) {

          this.writePacket(queued.type, queued.body);
        }

        this.emit('connect');

        break;

      case PacketType.PUBLISH & 0xF0: {

        const qos = (header >> 1) & 0x03;

        // Validate the encoded lengths before decoding - a truncated or malformed packet from the broker must never crash us. We log it, drop the connection,
        // and let our reconnection logic recover.
        if((packet.length < 2) || ((2 + packet.readUInt16BE(0) + ((qos > 0) ? 2 : 0)) > packet.length)) {

          this.emitError(new Error('Invalid MQTT packet received: malformed PUBLISH packet.'));
          this.socket?.destroy();

          return;
        }

        const topicLength = packet.readUInt16BE(0);
        const topic = packet.subarray(2, 2 + topicLength).toString('utf8');
        let payloadStart = 2 + topicLength;

        // QoS 1 and 2 messages carry a packet identifier we need to skip over, and QoS 1 messages need to be acknowledged.
        if(qos > 0) {

          const packetId = packet.readUInt16BE(payloadStart);

          payloadStart += 2;

          if(qos === 1) {

            const ack = Buffer.alloc(2);

            ack.writeUInt16BE(packetId, 0);
            this.writePacket(PacketType.PUBACK, ack);
          }
        }

        this.emit('message', topic, packet.subarray(payloadStart));

        break;
      }

      default:

        // SUBACK, UNSUBACK, and PINGRESP need no action for our QoS 0 use case.
        break;
    }
  }

  // Start the keepalive heartbeat with the broker. Beyond sending PINGREQ packets, this doubles as a liveness watchdog: if the broker has gone quiet for two
  // consecutive keepalive intervals - no PINGRESP, no traffic of any kind - we treat the connection as dead and tear it down so our reconnection logic can kick
  // in, rather than waiting for the operating system's much slower TCP timeout to notice.
  private startKeepalive(): void {

    this.stopKeepalive();
    this.pendingPings = 0;

    this.keepaliveTimer = setInterval(() => {

      // The broker hasn't responded to our last two pings - the connection is dead.
      if(this.pendingPings >= 2) {

        this.socket?.destroy();

        return;
      }

      this.pendingPings++;
      this.writePacket(PacketType.PINGREQ, Buffer.alloc(0));
    }, MQTT_KEEPALIVE * 1000 * 0.75);
  }

  // Stop the keepalive heartbeat.
  private stopKeepalive(): void {

    if(this.keepaliveTimer) {

      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // Emit an error event, but only when someone is listening. An unlistened error event would throw and take down the entire process - this connection
  // auto-reconnects in the background for the life of the process, so transport errors must never be fatal on their own.
  private emitError(error: Error): void {

    if(this.listenerCount('error')) {

      this.emit('error', error);
    }
  }

  // Cleanup our socket state after a disconnect.
  private teardownSocket(): void {

    if(this.connectTimer) {

      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    this.stopKeepalive();
    this.socket?.removeAllListeners();
    this.socket = null;
    this.connected = false;

    // Drop anything still queued for the handshake that never completed - subscriptions are restored from subscribedTopics when we reconnect, and QoS 0
    // publishes carry no delivery guarantee across connections.
    this.queuedPackets = [];
  }

  // Schedule a reconnection attempt, if we haven't been shutdown.
  private scheduleReconnect(): void {

    if(this.ended || this.reconnectTimer || !this.reconnectPeriod) {

      return;
    }

    this.reconnectTimer = setTimeout(() => {

      this.reconnectTimer = null;
      this.open();
    }, this.reconnectPeriod);
  }

  // Write a complete MQTT packet to the broker.
  private writePacket(type: PacketType, body: Buffer): void {

    if(!this.socket || this.socket.destroyed) {

      return;
    }

    this.socket.write(Buffer.concat([ Buffer.from([ type ]), encodeLength(body.length), body ]));
  }

  // Write an application packet to the broker, queueing it if the connection handshake hasn't completed yet. CONNECT must be the first packet on the wire
  // [MQTT-3.1.0-1], so anything issued before CONNACK is accepted is held back and flushed once the session is established. With no connection attempt in
  // flight, packets are dropped, matching our QoS 0 semantics while we wait to reconnect.
  private writeApplicationPacket(type: PacketType, body: Buffer): void {

    if(!this.socket || this.socket.destroyed) {

      return;
    }

    if(!this.connected) {

      this.queuedPackets.push({ body, type });

      return;
    }

    this.writePacket(type, body);
  }

  // Return the next packet identifier to use for SUBSCRIBE and UNSUBSCRIBE packets.
  private nextPacketId(): Buffer {

    this.packetId = (this.packetId % 65535) + 1;

    const id = Buffer.alloc(2);

    id.writeUInt16BE(this.packetId, 0);

    return id;
  }

  // Send a SUBSCRIBE packet for a topic at QoS 0.
  private sendSubscribe(topic: string): void {

    this.writePacket(PacketType.SUBSCRIBE, Buffer.concat([ this.nextPacketId(), encodeString(topic), Buffer.from([ 0x00 ]) ]));
  }

  // Publish a message to a topic at QoS 0.
  public publish(topic: string, message: string | Buffer): void {

    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');

    this.writeApplicationPacket(PacketType.PUBLISH, Buffer.concat([ encodeString(topic), payload ]));
  }

  // Subscribe to a topic at QoS 0. Subscriptions are automatically restored when we reconnect, and subscriptions made before the connection handshake completes
  // are established by that same restoration pass once CONNACK arrives.
  public subscribe(topic: string): void {

    this.subscribedTopics.add(topic);

    if(this.connected) {

      this.sendSubscribe(topic);
    }
  }

  // Unsubscribe from a topic.
  public unsubscribe(topic: string): void {

    this.subscribedTopics.delete(topic);
    this.writeApplicationPacket(PacketType.UNSUBSCRIBE, Buffer.concat([ this.nextPacketId(), encodeString(topic) ]));
  }

  // End the connection to the broker. When force is set, the socket is destroyed immediately.
  public end(force = false): void {

    this.ended = true;

    if(this.reconnectTimer) {

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopKeepalive();

    if(!this.socket) {

      return;
    }

    // Before the handshake completes, DISCONNECT can't be sent - CONNECT must be the first packet on the wire - so tear the socket down directly.
    if(force || !this.connected) {

      this.socket.destroy();

      return;
    }

    // Politely tell the broker we're leaving before closing the socket.
    this.writePacket(PacketType.DISCONNECT, Buffer.alloc(0));
    this.socket.end();
  }
}
