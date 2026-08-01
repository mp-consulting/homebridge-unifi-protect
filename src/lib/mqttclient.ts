/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * mqttclient.ts: MQTT connectivity class for the plugin.
 */
import type { HomebridgePluginLogging, Nullable } from './util.js';
import { MqttConnection } from './mqtt-connection.js';
import util from 'node:util';

const MQTT_DEFAULT_RECONNECT_INTERVAL = 60;

/**
 * MQTT connectivity and topic management class.
 *
 * This class manages connection, publishing, subscription, and message handling for an MQTT broker, and provides convenience methods for Homebridge accessories
 * to interact with MQTT topics using a standard topic prefix.
 */
export class MqttClient {

  private brokerUrl: string;
  private isConnected: boolean;
  private reconnectInterval: number;
  private log: HomebridgePluginLogging;
  private mqtt: Nullable<MqttConnection>;
  private subscriptions: Map<string, (message: Buffer) => Promise<void> | void>;
  private topicPrefix: string;

  // Creates a new MQTT client for connecting to a broker and managing topics with a given prefix.
  constructor(brokerUrl: string, topicPrefix: string, log: HomebridgePluginLogging, reconnectInterval = MQTT_DEFAULT_RECONNECT_INTERVAL) {

    this.brokerUrl = brokerUrl;
    this.isConnected = false;
    this.log = log;
    this.mqtt = null;
    this.reconnectInterval = reconnectInterval;
    this.subscriptions = new Map();
    this.topicPrefix = topicPrefix;

    this.configure();
  }

  // Initializes and connects the MQTT client to the broker, setting up event handlers for connection, messages, and errors.
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = new MqttConnection(this.brokerUrl, { reconnectPeriod: this.reconnectInterval * 1000, rejectUnauthorized: false });
    } catch(error) {

      if(error instanceof Error) {

        if(error.message === 'Missing protocol') {

          this.log.error('MQTT Broker: Invalid URL provided: %s.', this.brokerUrl);
        } else if(error.message.startsWith('Unsupported protocol')) {

          this.log.error('MQTT Broker: %s. Only mqtt://, mqtts://, tcp://, and ssl:// broker URLs are supported: %s.', error.message.replace(/\.$/, ''),
            this.brokerUrl);
        } else {

          this.log.error('MQTT Broker: Error: %s.', error.message);
        }
      }
    }

    // We've been unable to even attempt to connect. It's likely we have a configuration issue - we're done here.
    if(!this.mqtt) {

      return;
    }

    // Notify the user when we connect to the broker.
    this.mqtt.on('connect', () => {

      this.isConnected = true;

      // Inform users, while redacting authentication credentials.
      this.log.info('MQTT Broker: Connected to %s (topic: %s).', this.brokerUrl.replace(/^(.*:\/\/.*:)(.*)(@.*)$/, '$1REDACTED$3'), this.topicPrefix);
    });

    // Notify the user when we've disconnected.
    this.mqtt.on('close', () => {

      // We only inform users if we're already connected. Otherwise, we're likely in an error state and that's logged elsewhere.
      if(!this.isConnected) {

        return;
      }

      this.isConnected = false;

      // Inform users.
      this.log.info('MQTT Broker: Connection closed.');
    });

    // Process inbound messages and pass it to the right message handler.
    this.mqtt.on('message', (topic: string, message: Buffer) => {

      void this.subscriptions.get(topic)?.(message);
    });

    // Notify the user when there's a connectivity error.
    this.mqtt.on('error', (error: NodeJS.ErrnoException) => {

      const logError = (message: string): void => {

        this.log.error('MQTT Broker: %s. Will retry again in %s second%s.', message, this.reconnectInterval, this.reconnectInterval !== 1 ? 's' : '');
      };

      switch(error.code) {

        case 'ECONNREFUSED':

          logError('Connection refused');

          break;

        case 'ECONNRESET':

          logError('Connection reset');

          break;

        case 'ENOTFOUND':

          this.mqtt?.end(true);
          this.log.error('MQTT Broker: Hostname or IP address not found.');

          break;

        default:

          logError(util.inspect(error, { sorted: true }));

          break;
      }
    });
  }

  // Publishes a message to a topic for a specific device.
  public publish(id: string, topic: string, message: string): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug('MQTT publish: %s Message: %s.', expandedTopic, message);

    // By default, we publish as: pluginTopicPrefix/id/topic
    this.mqtt?.publish(expandedTopic, message);
  }

  // Subscribes to a topic for a specific device and registers a handler for incoming messages.
  public subscribe(id: string, topic: string, callback: (message: Buffer) => Promise<void> | void): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug('MQTT subscribe: %s.', expandedTopic);

    // Add to our callback list.
    this.subscriptions.set(expandedTopic, callback);

    // Tell MQTT we're subscribing to this event.
    // By default, we subscribe as: pluginTopicPrefix/id/topic
    this.mqtt?.subscribe(expandedTopic);
  }

  // Subscribes to a '<topic>/get' topic and publishes a value in response to "true" messages.
  public subscribeGet(id: string, topic: string, type: string, getValue: () => string, log: HomebridgePluginLogging = this.log): void {

    // Subscribe to the get topic and publish the current value when requested.
    this.subscribe(id, topic + '/get', (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // We only respond to "true" messages on the get topic.
      if(value !== 'true') {

        return;
      }

      this.publish(id, topic, getValue());
      log.info('MQTT: %s status published.', type);
    });
  }

  // Subscribes to a '<topic>/set' topic and calls a setter when a message is received.
  public subscribeSet(id: string, topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void,
    log: HomebridgePluginLogging = this.log): void {

    // Subscribe to the set topic and invoke the setter callback when a value is received.
    this.subscribe(id, topic + '/set', async (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // Set our value and inform the user.
      try {

        await setValue(value, message.toString());
        log.info('MQTT: set message received for %s: %s.', type, value);
      } catch(error) {

        log.error('MQTT: error setting %s to %s: %s.', type, value, (error instanceof Error ? error.message : String(error)).replace(/\.$/, ''));
      }
    });
  }

  // Unsubscribes from a topic for a specific device, removing its message handler.
  public unsubscribe(id: string, topic: string): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.subscriptions.delete(expandedTopic);
    this.mqtt?.unsubscribe(expandedTopic);
  }

  // Expands a topic string into a fully-formed topic path including the prefix and device ID.
  private expandTopic(id: string, topic: string): Nullable<string> {

    // No id, we're done.
    if(!id) {

      return null;
    }

    return this.topicPrefix + '/' + id + '/' + topic;
  }
}
