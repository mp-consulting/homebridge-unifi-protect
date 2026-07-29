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

  it('emits a connection-refused error when the broker rejects the connection', async () => {

    const broker = await createBroker({ connackCode: 5 });

    cleanup.push(() => broker.server.close());

    const mqtt = new MqttConnection('mqtt://localhost:' + broker.port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    const [ error ] = await once(mqtt, 'error') as [ NodeJS.ErrnoException ];

    expect(error.code).toBe('ECONNREFUSED');
    expect(error.message).toContain('return code 5');
  });

  it('throws Missing protocol for invalid broker URLs', () => {

    expect(() => new MqttConnection('nonsense')).toThrow('Missing protocol');
    expect(() => new MqttConnection('http://localhost')).toThrow('Missing protocol');
  });

  it('tears down the connection when the broker stops answering pings', async () => {

    const broker = await createBroker({ respondToPings: false });

    cleanup.push(() => broker.server.close());

    // Fake only the interval timer that drives the keepalive so we can fast-forward through it. Everything else - socket I/O in particular - stays real.
    vi.useFakeTimers({ toFake: [ 'setInterval' ] });

    const mqtt = new MqttConnection('mqtt://localhost:' + broker.port, { reconnectPeriod: 0 });

    cleanup.push(() => mqtt.end(true));

    await once(mqtt, 'connect');

    const closed = once(mqtt, 'close');

    // Two unanswered keepalive intervals, then the watchdog fires on the third.
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(45000);

    await closed;

    expect(broker.events.filter(event => event.type === 'pingreq').length).toBe(2);
  });
});
