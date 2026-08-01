/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * lib-mqtt.test.ts: Tests for the dependency-free MQTT 3.1.1 client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { MqttConnection } from '../src/lib/mqtt-connection.js';
import net from 'node:net';
import { once } from 'node:events';

type BrokerEvent = { type: string; hasUsername?: boolean; hasPassword?: boolean; topic?: string; payload?: string };

// A minimal mock MQTT broker for exercising the client.
function createBroker(options: { connackCode?: number; respondToPings?: boolean } = {}):
  Promise<{ events: BrokerEvent[]; port: number; server: net.Server }> {

  const events: BrokerEvent[] = [];

  const server = net.createServer(socket => {

    let buffer = Buffer.alloc(0);

    socket.on('data', data => {

      buffer = Buffer.concat([ buffer, data ]);

      for(;;) {

        if(buffer.length < 2) {

          return;
        }

        // Decode the remaining length varint.
        let length = 0;
        let multiplier = 1;
        let offset = 1;

        for(;;) {

          const byte = buffer[offset++];

          length += (byte & 0x7F) * multiplier;
          multiplier *= 128;

          if(!(byte & 0x80)) {

            break;
          }
        }

        if(buffer.length < (offset + length)) {

          return;
        }

        const type = buffer[0] & 0xF0;
        const body = buffer.subarray(offset, offset + length);

        buffer = buffer.subarray(offset + length);

        switch(type) {

          case 0x10: {

            // CONNECT: note the credential flags and acknowledge.
            events.push({ hasPassword: !!(body[7] & 0x40), hasUsername: !!(body[7] & 0x80), type: 'connect' });
            socket.write(Buffer.from([ 0x20, 2, 0, options.connackCode ?? 0 ]));

            break;
          }

          case 0x80: {

            // SUBSCRIBE: acknowledge, then publish a canned message to the subscribed topic.
            const topicLength = body.readUInt16BE(2);
            const topic = body.subarray(4, 4 + topicLength).toString();

            events.push({ topic, type: 'subscribe' });
            socket.write(Buffer.from([ 0x90, 3, body[0], body[1], 0 ]));

            const topicBuffer = Buffer.from(topic);
            const lengthPrefix = Buffer.alloc(2);

            lengthPrefix.writeUInt16BE(topicBuffer.length, 0);

            const publishBody = Buffer.concat([ lengthPrefix, topicBuffer, Buffer.from('inbound!') ]);

            socket.write(Buffer.concat([ Buffer.from([ 0x30, publishBody.length ]), publishBody ]));

            break;
          }

          case 0xA0: {

            const topicLength = body.readUInt16BE(2);

            events.push({ topic: body.subarray(4, 4 + topicLength).toString(), type: 'unsubscribe' });
            socket.write(Buffer.from([ 0xB0, 2, body[0], body[1] ]));

            break;
          }

          case 0x30: {

            const topicLength = body.readUInt16BE(0);

            events.push({ payload: body.subarray(2 + topicLength).toString(), topic: body.subarray(2, 2 + topicLength).toString(), type: 'publish' });

            break;
          }

          case 0xC0:

            events.push({ type: 'pingreq' });

            if(options.respondToPings ?? true) {

              socket.write(Buffer.from([ 0xD0, 0 ]));
            }

            break;

          default:

            break;
        }
      }
    });
  });

  return new Promise(resolve => server.listen(0, () => resolve({ events, port: (server.address() as AddressInfo).port, server })));
}

describe('MqttConnection', () => {

  const cleanup: (() => void)[] = [];

  afterEach(() => {

    vi.useRealTimers();

    for(const fn of cleanup.splice(0)) {

      fn();
    }
  });

  it('connects with credentials, subscribes, publishes, and routes inbound messages', async () => {

    const broker = await createBroker();

    cleanup.push(() => broker.server.close());

    const mqtt = new MqttConnection('mqtt://user:pass@localhost:' + broker.port);

    cleanup.push(() => mqtt.end(true));

    const inbound: [ string, string ][] = [];

    mqtt.on('message', (topic: string, message: Buffer) => inbound.push([ topic, message.toString() ]));

    await once(mqtt, 'connect');

    expect(broker.events).toContainEqual({ hasPassword: true, hasUsername: true, type: 'connect' });

    mqtt.subscribe('house/door/status');
    mqtt.publish('house/door/trigger', 'on');

    await vi.waitFor(() => expect(inbound).toContainEqual([ 'house/door/status', 'inbound!' ]));

    expect(broker.events).toContainEqual({ topic: 'house/door/status', type: 'subscribe' });
    expect(broker.events).toContainEqual({ payload: 'on', topic: 'house/door/trigger', type: 'publish' });

    mqtt.unsubscribe('house/door/status');

    await vi.waitFor(() => expect(broker.events).toContainEqual({ topic: 'house/door/status', type: 'unsubscribe' }));
  });

  it('queues application packets issued before the handshake so CONNECT is first on the wire', async () => {

    const broker = await createBroker();

    cleanup.push(() => broker.server.close());

    const mqtt = new MqttConnection('mqtt://localhost:' + broker.port);

    cleanup.push(() => mqtt.end(true));

    // Subscribe and publish immediately, before the TCP connection has even completed - nothing may reach the broker ahead of CONNECT [MQTT-3.1.0-1].
    mqtt.subscribe('house/door/status');
    mqtt.publish('house/door/trigger', 'on');

    await once(mqtt, 'connect');

    await vi.waitFor(() => expect(broker.events).toContainEqual({ payload: 'on', topic: 'house/door/trigger', type: 'publish' }));

    // CONNECT must be the first packet the broker sees, with the held-back subscribe and publish following only after CONNACK.
    expect(broker.events[0]).toMatchObject({ type: 'connect' });
    expect(broker.events).toContainEqual({ topic: 'house/door/status', type: 'subscribe' });

    // The pre-connect subscription is established by the CONNACK restoration pass alone - it must not be sent a second time from a queue.
    expect(broker.events.filter(event => event.type === 'subscribe').length).toBe(1);
  });

  it('emits a connection-refused error when the broker rejects the connection', async () => {

    const broker = await createBroker({ connackCode: 5 });

    cleanup.push(() => broker.server.close());

    const mqtt = new MqttConnection('mqtt://localhost:' + broker.port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    const [ error ] = await once(mqtt, 'error') as [ NodeJS.ErrnoException ];

    expect(error.code).toBe('ECONNREFUSED');
    expect(error.message).toContain('return code 5');
  });

  it('throws descriptive errors for invalid and unsupported broker URLs', () => {

    expect(() => new MqttConnection('nonsense')).toThrow('Missing protocol');
    expect(() => new MqttConnection('http://localhost')).toThrow('Unsupported protocol: http');

    // MQTT-over-WebSocket is deliberately unsupported and must be called out rather than reported as a malformed URL.
    expect(() => new MqttConnection('ws://localhost:9001')).toThrow('Unsupported protocol: ws');
  });

  it('tears down the connection when the broker stops answering pings', async () => {

    const broker = await createBroker({ respondToPings: false });

    cleanup.push(() => broker.server.close());

    // Fake the interval timer that drives the keepalive so we can fast-forward through it - and its matching clearInterval, so teardown clears the fake timer
    // rather than silently no-oping against a real one. Everything else - socket I/O in particular - stays real.
    vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval' ] });

    const mqtt = new MqttConnection('mqtt://localhost:' + broker.port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    await once(mqtt, 'connect');

    const closed = once(mqtt, 'close');

    // Two unanswered keepalive intervals, then the watchdog fires on the third.
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(45000);

    await closed;

    await vi.waitFor(() => expect(broker.events.filter(event => event.type === 'pingreq').length).toBe(2));
  });

  it('tears down the connection when the broker never answers with a CONNACK', async () => {

    // A server that accepts the TCP connection but never speaks MQTT.
    const server = net.createServer(() => {});

    await new Promise<void>(resolve => server.listen(0, resolve));
    cleanup.push(() => server.close());

    const gotConnect = new Promise<void>(resolve => server.on('connection', socket => socket.once('data', () => resolve())));

    vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] });

    const mqtt = new MqttConnection('mqtt://localhost:' + (server.address() as AddressInfo).port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    // The handshake timeout surfaces as an error alongside the teardown. events.once() rejects its promise when an error event fires, so wait for the close
    // event directly rather than through it.
    const errors: Error[] = [];

    mqtt.on('error', (error: Error) => errors.push(error));

    const closed = new Promise<void>(resolve => mqtt.once('close', () => resolve()));

    // Once our CONNECT packet has reached the silent server, the handshake timeout is armed - fast-forward through it.
    await gotConnect;
    await vi.advanceTimersByTimeAsync(10000);

    await closed;

    expect(errors.map(error => error.message)).toContainEqual(expect.stringContaining('Timed out waiting for the MQTT broker'));
  });

  it('survives a malformed PUBLISH packet by tearing down the connection instead of throwing', async () => {

    // A server that answers the CONNECT with a valid CONNACK, then sends a PUBLISH with a truncated body - a naive parser would throw out of the socket's data
    // handler and crash the process.
    const server = net.createServer(socket => {

      socket.once('data', () => {

        socket.write(Buffer.from([ 0x20, 2, 0, 0 ]));
        socket.write(Buffer.from([ 0x30, 0x00 ]));
      });
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    cleanup.push(() => server.close());

    const mqtt = new MqttConnection('mqtt://localhost:' + (server.address() as AddressInfo).port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    // Await the error before attaching the close waiter - events.once() rejects a pending waiter when an error event fires first. The close event trails the
    // error by at least a tick, so attaching afterwards can't miss it.
    const [ error ] = await once(mqtt, 'error') as [ Error ];

    expect(error.message).toContain('Invalid MQTT packet');

    await once(mqtt, 'close');
  });

  it('rejects a broker-declared packet length above the maximum', async () => {

    // A valid CONNACK followed by a packet declaring a 32 MiB remaining length.
    const server = net.createServer(socket => {

      socket.once('data', () => {

        socket.write(Buffer.from([ 0x20, 2, 0, 0 ]));
        socket.write(Buffer.from([ 0x30, 0x80, 0x80, 0x80, 0x10 ]));
      });
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    cleanup.push(() => server.close());

    const mqtt = new MqttConnection('mqtt://localhost:' + (server.address() as AddressInfo).port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    const [ error ] = await once(mqtt, 'error') as [ Error ];

    expect(error.message).toContain('exceeds the maximum');

    await once(mqtt, 'close');
  });
});
