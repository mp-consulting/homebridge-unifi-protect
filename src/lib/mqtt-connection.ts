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
  private ended: boolean;
  private host: string;
  private keepaliveTimer: Nullable<NodeJS.Timeout>;
  private packetId: number;
  private password?: string;
  private port: number;
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

    // We support TCP and TLS transports only.
    if(!['mqtt', 'mqtts', 'ssl', 'tcp'].includes(protocol)) {

      throw new Error('Missing protocol');
    }

    this.useTls = ['mqtts', 'ssl'].includes(protocol);
    this.host = url.hostname;
    this.port = url.port ? parseInt(url.port) : (this.useTls ? 8883 : 1883);
    this.username = url.username ? decodeURIComponent(url.username) : undefined;
    this.password = url.password ? decodeURIComponent(url.password) : undefined;

    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.keepaliveTimer = null;
    this.packetId = 0;
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

    socket.on('data', (data: Buffer) => this.processData(data));

    socket.on('error', (error: Error) => {

      this.emit('error', error);
    });

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

    switch(header & 0xF0) {

      case PacketType.CONNACK & 0xF0:

        // Check the connect return code.
        if(packet[1] !== 0) {

          this.emit('error', Object.assign(new Error('Connection refused by the MQTT broker: return code ' + packet[1] + '.'), { code: 'ECONNREFUSED' }));
          this.socket?.destroy();

          return;
        }

        // We're connected. Restore any subscriptions we had and start our keepalive heartbeat.
        this.startKeepalive();

        for(const topic of this.subscribedTopics) {

          this.sendSubscribe(topic);
        }

        this.emit('connect');

        break;

      case PacketType.PUBLISH & 0xF0: {

        const qos = (header >> 1) & 0x03;
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

  // Start the keepalive heartbeat with the broker.
  private startKeepalive(): void {

    this.stopKeepalive();

    this.keepaliveTimer = setInterval(() => this.writePacket(PacketType.PINGREQ, Buffer.alloc(0)), MQTT_KEEPALIVE * 1000 * 0.75);
  }

  // Stop the keepalive heartbeat.
  private stopKeepalive(): void {

    if(this.keepaliveTimer) {

      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // Cleanup our socket state after a disconnect.
  private teardownSocket(): void {

    this.stopKeepalive();
    this.socket?.removeAllListeners();
    this.socket = null;
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

    this.writePacket(PacketType.PUBLISH, Buffer.concat([ encodeString(topic), payload ]));
  }

  // Subscribe to a topic at QoS 0. Subscriptions are automatically restored when we reconnect.
  public subscribe(topic: string): void {

    this.subscribedTopics.add(topic);
    this.sendSubscribe(topic);
  }

  // Unsubscribe from a topic.
  public unsubscribe(topic: string): void {

    this.subscribedTopics.delete(topic);
    this.writePacket(PacketType.UNSUBSCRIBE, Buffer.concat([ this.nextPacketId(), encodeString(topic) ]));
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

    if(force) {

      this.socket.destroy();

      return;
    }

    // Politely tell the broker we're leaving before closing the socket.
    this.writePacket(PacketType.DISCONNECT, Buffer.alloc(0));
    this.socket.end();
  }
}
