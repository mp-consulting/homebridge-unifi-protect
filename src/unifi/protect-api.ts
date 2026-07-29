/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api.ts: Our UniFi Protect API implementation, built exclusively on Node.js runtime primitives.
 */

/**
 * A complete implementation of the UniFi Protect API, providing comprehensive access to UniFi Protect controllers.
 *
 * ## Overview
 *
 * This module provides a high-performance, event-driven interface to the UniFi Protect API, enabling full access to
 * Protect's rich ecosystem of security devices and capabilities. The API has been reverse-engineered through careful
 * analysis of the Protect web interface and extensive testing, as Ubiquiti does not provide official documentation.
 *
 * ## Key Features
 *
 * - **Complete Device Support**: Cameras, lights, sensors, chimes, viewers, and the NVR itself
 * - **Real-time Events**: WebSocket-based event streaming for instant notifications
 * - **Livestream Access**: Direct H.264 fMP4 stream access, not just RTSP
 * - **Robust Error Handling**: Automatic retry logic with exponential backoff
 * - **Type Safety**: Full TypeScript support with comprehensive type definitions
 *
 * ## Architecture
 *
 * The API is built exclusively on Node.js runtime primitives:
 * - **node:https**: HTTP/1.1 client with connection pooling through a keepalive agent
 * - **WebSockets**: Real-time bidirectional communication through our own RFC 6455 client
 * - **EventEmitter**: Node.js event-driven architecture
 *
 * ## Authentication
 *
 * The API uses cookie-based authentication with CSRF token protection, mimicking the Protect web interface.
 * Administrative privileges are required for configuration changes, while read-only access is available to all users.
 *
 * @module ProtectApi
 */
import type { DeepPartial, Nullable, ProtectCameraChannelConfigInterface, ProtectCameraConfig, ProtectCameraConfigInterface, ProtectChimeConfig,
  ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig, ProtectSensorConfig, ProtectViewerConfig } from './protect-types.js';
import type { ProtectEventPacket } from './protect-api-events.js';
import type { ProtectLogging } from './protect-logging.js';
import type { RequestResponse } from '../lib/request.js';
import { decodePacket } from './protect-api-events.js';
import { ProtectLivestream } from './protect-api-livestream.js';
import { request } from '../lib/request.js';
import { WebSocketClient } from '../lib/websocket.js';
import { EventEmitter } from 'node:events';
import { STATUS_CODES } from 'node:http';
import https from 'node:https';
import util from 'node:util';

// Number of API errors to accept before we backoff so we don't slam a Protect controller.
const PROTECT_API_ERROR_LIMIT = 10;

// Interval, in seconds, to wait before trying to access the API again once we've hit the PROTECT_API_ERROR_LIMIT threshold.
const PROTECT_API_RETRY_INTERVAL = 300;

// Protect API response timeout, in milliseconds. This should never be greater than 5000 ms.
const PROTECT_API_TIMEOUT = 3500;

// Protect controller status codes that indicate transient server-side issues. These should be kept in sync with the transparent retry policy that we hand to
// request() in _retrieve, which retries on a subset of these codes before _retrieve ever sees them.
//
// 400: Bad request.
// 404: Not found.
// 429: Too many requests.
// 500: Internal server error.
// 502: Bad gateway.
// 503: Service temporarily unavailable.
// 504: Gateway timeout.
const PROTECT_SERVER_ERRORS = new Set([ 400, 404, 429, 500, 502, 503, 504 ]);

/**
 * The Protect device types we know about and are available to us.
 */
export type ProtectKnownDeviceTypes = ProtectCameraConfig | ProtectChimeConfig | ProtectLightConfig | ProtectNvrConfig | ProtectSensorConfig |
  ProtectViewerConfig;

/**
 * The model key identifiers for known Protect device categories, derived from the device type interfaces.
 */
export type ProtectKnownDeviceModelKey = ProtectKnownDeviceTypes['modelKey'];

/**
 * Known Protect API endpoint identifiers accepted by {@link ProtectApi.getApiEndpoint}. Device endpoints correspond to {@link ProtectKnownDeviceModelKey}
 * values.
 */
export type ProtectApiEndpoint = ProtectKnownDeviceModelKey | 'bootstrap' | 'login' | 'self' | 'websocket';

/**
 * The Protect device payload types we know about and are available to us.
 */
export type ProtectKnownDevicePayloads = DeepPartial<ProtectCameraConfig> | DeepPartial<ProtectChimeConfig> | DeepPartial<ProtectLightConfig> |
  DeepPartial<ProtectNvrConfig> | DeepPartial<ProtectSensorConfig> | DeepPartial<ProtectViewerConfig>;

/**
 * The Protect NVR bootstrap data type used by the {@link ProtectApi.bootstrap | bootstrap} getter. Device interfaces include index signatures for accessing
 * untyped API fields without casting.
 */
export type ProtectNvrBootstrapData = Nullable<ProtectNvrBootstrap>;

/**
 * Configuration options for HTTP requests executed by `retrieve()`.
 *
 * @remarks The caller controls the method and body of the request...we own the transport and identity, so every request uses our authenticated session (cookie,
 * CSRF token) and connection pool.
 */
export interface RequestOptions {

  body?: string;
  method?: string;
}

/**
 * Options to tailor the behavior of {@link ProtectApi.retrieve}.
 *
 * @property {boolean} [logErrors=true] - Log errors. Defaults to `true`.
 * @property {number} [timeout=3500] - Amount of time, in milliseconds, to wait for the Protect controller to respond before timing out. Defaults to `3500`.
 */
export interface RetrieveOptions {

  logErrors?: boolean;
  timeout?: number;
}

// Internal options for our private _retrieve interface, adding the ability to hand response interpretation back to the caller.
interface InternalRetrieveOptions extends RetrieveOptions {

  decodeResponse?: boolean;
}

/**
 * This class provides an event-driven API to access the UniFi Protect API.
 *
 * ## Getting Started
 *
 * To begin using the API, follow these three essential steps:
 *
 * 1. **Login**: Authenticate with the Protect controller using {@link login}
 * 2. **Bootstrap**: Retrieve the controller configuration with {@link getBootstrap}
 * 3. **Listen**: Subscribe to real-time events via the `message` event
 *
 * ## Events
 *
 * The API emits several events during its lifecycle:
 *
 * | Event | Payload | Description |
 * |-------|---------|-------------|
 * | `login` | `boolean` | Emitted after each login attempt with success status |
 * | `bootstrap` | {@link ProtectNvrBootstrap} | Emitted when bootstrap data is retrieved |
 * | `message` | {@link ProtectEventPacket} | Real-time event packets from the controller |
 *
 * ## Connection Management
 *
 * The API automatically manages connection pooling and implements intelligent retry logic:
 * - Up to 5 concurrent connections
 * - Automatic retry with exponential backoff
 * - Throttling after repeated failures
 * - Graceful WebSocket reconnection
 *
 * ## Error Handling
 *
 * All API methods implement comprehensive error handling:
 * - Network errors are logged and retried
 * - Authentication failures trigger re-login attempts
 * - Server errors are handled gracefully
 * - Detailed logging for debugging
 *
 * @event login     - Emitted after each login attempt with the success status as a boolean value. This event fires whether the login succeeds or fails,
 *                    allowing applications to respond appropriately to authentication state changes.
 * @event bootstrap - Emitted when bootstrap data is successfully retrieved from the controller. The event includes the complete {@link ProtectNvrBootstrap}
 *                    configuration object containing all device states and system settings.
 * @event message   - Emitted for each real-time event packet received from the controller's WebSocket connection. The event includes a
 *                    {@link ProtectEventPacket} containing device updates, motion events, and other system notifications.
 */
export class ProtectApi extends EventEmitter {

  private _bootstrap: Nullable<ProtectNvrBootstrap>;
  private _eventsWs: Nullable<WebSocketClient>;
  private agent: Nullable<https.Agent>;
  private apiErrorCount: number;
  private apiThrottleStart: number;
  private headers: Record<string, string>;
  private _isAdminUser: boolean;
  private _isThrottled: boolean;
  private log: ProtectLogging;
  private nvrAddress: string;
  private password: string;
  private username: string;

  /**
   * Create an instance of the UniFi Protect API.
   *
   * @param log - Custom logging implementation.
   *
   * @defaultValue Console logging to stdout/stderr
   *
   * @remarks The logging interface allows you to integrate the API with your application's logging system. By default, errors and warnings are logged to the
   *   console, while debug messages are suppressed.
   *
   * @category Constructor
   */
  constructor(log?: ProtectLogging) {

    // Initialize our parent.
    super();

    // If we didn't get passed a logging parameter, by default we log to the console.
    log ??= {

      debug: (): void => {},
      error: (message: string, ...parameters: unknown[]): void => console.error(message, ...parameters),
      info: (message: string, ...parameters: unknown[]): void => console.log(message, ...parameters),
      warn: (message: string, ...parameters: unknown[]): void => console.log(message, ...parameters),
    };

    this._bootstrap = null;
    this._eventsWs = null;
    this._isAdminUser = false;
    this._isThrottled = false;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => log.debug(this.name + ': ' + message, ...parameters),
      error: (message: string, ...parameters: unknown[]): void => log.error(this.name + ': API error: ' + message, ...parameters),
      info: (message: string, ...parameters: unknown[]): void => log.info(this.name + ': ' + message, ...parameters),
      warn: (message: string, ...parameters: unknown[]): void => log.warn(this.name + ': ' + message, ...parameters),
    };

    this.agent = null;
    this.apiErrorCount = 0;
    this.apiThrottleStart = 0;
    this.headers = {};
    this.nvrAddress = '';
    this.password = '';
    this.username = '';
  }

  /**
   * Execute a login attempt to the UniFi Protect API.
   *
   * @param nvrAddress - Address of the UniFi Protect controller (FQDN or IP address)
   * @param username   - Username for authentication
   * @param password   - Password for authentication
   *
   * @returns Promise resolving to `true` on success, `false` on failure.
   *
   * @event login      - Emitted with `true` if authentication succeeds, `false` if it fails. The event fires after every login attempt, regardless of outcome.
   *
   * @remarks This method performs the following actions:
   *
   * - Terminates any existing sessions
   * - Acquires CSRF tokens for API security
   * - Establishes cookie-based authentication
   * - Emits a `login` event with the result
   *
   * The method automatically handles UniFi OS CSRF protection and maintains session state for subsequent API calls. Administrative privileges are determined
   * during login and cached for the session duration.
   *
   * @category Authentication
   */
  public async login(nvrAddress: string, username: string, password: string): Promise<boolean> {

    this.nvrAddress = nvrAddress;
    this.username = username;
    this.password = password;

    this.logout();

    // Let's attempt to login.
    const loginSuccess = await this.loginController();

    // Publish the result to our listeners.
    this.emit('login', loginSuccess);

    // Return the status of our login attempt.
    return loginSuccess;
  }

  // Login to the UniFi Protect API.
  private async loginController(): Promise<boolean> {

    // If we're already logged in, we're done.
    if(this.headers.cookie && this.headers['x-csrf-token']) {

      return true;
    }

    // Utility to grab the headers we're interested in a normalized manner.
    const getHeader = (name: string, headers?: RequestResponse['headers']): Nullable<string> => {

      const rawHeader = headers?.[name.toLowerCase()];

      if(!rawHeader) {

        return null;
      }

      // Normalize it to a string.
      return Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    };

    // Attempt to log in directly. If we already have a CSRF token (from a prior session or a previous login attempt), we skip the CSRF pre-fetch entirely and
    // go straight to the login endpoint. The login response provides an updated CSRF token, so the pre-fetch is only needed if we have no token at all and the
    // controller rejects our login without one.
    const loginBody = JSON.stringify({ password: this.password, rememberMe: true, token: '', username: this.username });

    let response = await this.retrieve(this.getApiEndpoint('login'), { body: loginBody, method: 'POST' });

    // If the login failed and we don't have a CSRF token, acquire one and retry. UniFi OS has cross-site request forgery protection built into its web
    // management UI. Some controllers require a valid CSRF token on the login request itself.
    if(!this.responseOk(response?.statusCode) && !this.headers['x-csrf-token']) {

      const csrfResponse = await this.retrieve('https://' + this.nvrAddress, { method: 'GET' }, { logErrors: false });

      if(this.responseOk(csrfResponse?.statusCode)) {

        const csrfToken = getHeader('X-CSRF-Token', csrfResponse?.headers);

        // Preserve the CSRF token, if found, and retry the login.
        if(csrfToken) {

          this.headers['x-csrf-token'] = csrfToken;
          response = await this.retrieve(this.getApiEndpoint('login'), { body: loginBody, method: 'POST' });
        }
      }
    }

    // Something went wrong with the login call, possibly a controller reboot or failure.
    if(!this.responseOk(response?.statusCode)) {

      this.logout();

      return false;
    }

    // We're logged in. Let's configure our headers.
    const csrfToken = getHeader('X-Updated-CSRF-Token', response?.headers) ?? getHeader('X-CSRF-Token', response?.headers);
    const cookie = getHeader('Set-Cookie', response?.headers);

    // Save the refreshed cookie and CSRF token for future API calls and we're done.
    if(csrfToken && cookie) {

      // Only preserve the token element of the cookie and not the superfluous information that's been added to it.
      this.headers.cookie = cookie.split(';')[0];

      // Save the CSRF token.
      this.headers['x-csrf-token'] = csrfToken;

      return true;
    }

    // Clear out our login credentials.
    this.logout();

    return false;
  }

  // Attempt to retrieve the bootstrap configuration from the Protect NVR.
  private async bootstrapController(retry: boolean): Promise<boolean> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return retry ? this.bootstrapController(false) : false;
    }

    const response = await this.retrieve(this.getApiEndpoint('bootstrap'));

    // Something went wrong. Retry the bootstrap attempt once, and then we're done.
    if(!this.responseOk(response?.statusCode)) {

      this.logRetry('Unable to retrieve the UniFi Protect controller configuration.', retry);

      return retry ? this.bootstrapController(false) : false;
    }

    // Now let's get our NVR configuration information.
    let data: Nullable<ProtectNvrBootstrap>;

    try {

      data = await response?.body.json() as ProtectNvrBootstrap;
    } catch(error) {

      this.log.error('Unable to parse response from UniFi Protect. Will retry again later.');

      return retry ? this.bootstrapController(false) : false;
    }

    // Is this the first time we're bootstrapping?
    const isFirstRun = !this._bootstrap;

    // Set the new bootstrap.
    this._bootstrap = data;

    // Check for admin user privileges or role changes.
    this.checkAdminUserStatus(isFirstRun);

    // We're good. Now connect to the event listener API.
    if(!(await this.launchEventsWs())) {

      return retry ? this.bootstrapController(false) : false;
    }

    // Notify our users.
    this.emit('bootstrap', this._bootstrap);

    // We're bootstrapped and connected to the events API.
    return true;
  }

  /**
   * Connect to the realtime update events API.
   *
   * @event message - Emitted for each WebSocket message received from the controller after successful decoding. Each message contains a
   *                  {@link ProtectEventPacket} with real-time device updates and system events.
   *
   * @internal
   */
  private async launchEventsWs(): Promise<boolean> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return false;
    }

    // If we already have a listener, we're already all set.
    if(this._eventsWs) {

      return true;
    }

    // Launch the realtime events WebSocket. We need to hand it the last update ID we know about in order
    // to ensure we don't miss any actual updates since we last pulled the bootstrap configuration.
    const params = new URLSearchParams({ lastUpdateId: this._bootstrap?.lastUpdateId ?? '' });

    try {

      // Let's open the WebSocket connection, passing our authentication cookie and explicitly allowing the self-signed TLS certificates that Protect
      // controllers ship with by default.
      const ws = new WebSocketClient('wss://' + this.nvrAddress + '/proxy/protect/ws/updates?' + params.toString(),
        { headers: { Cookie: this.headers.cookie ?? '' }, rejectUnauthorized: false });

      // Handle any WebSocket errors. A single once handler covers both the connection phase and the post-connection lifetime...the first error on the WebSocket
      // triggers logging, closes the connection, and the close event handles cleanup.
      ws.once('error', (error: Error) => {

        this.log.error('Events API error: %s', error.message);
        this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true }));
        ws.close();
      });

      // Wait for the WebSocket to actually connect before reporting success. This ensures bootstrapController() only signals success when both the HTTP
      // bootstrap and the realtime events channel are fully established. We use named handlers so that whichever fires first can remove the other, preventing
      // stale listeners from interfering with post-connection event handling.
      const connected = await new Promise<boolean>((resolve) => {

        function onOpen(this: ProtectApi): void {

          ws.off('close', onClose);

          // Make the WebSocket available.
          this._eventsWs = ws;
          resolve(true);
        }

        // If the connection fails, the error handler above will close the WebSocket. We listen for close to detect that the connection was never established.
        function onClose(): void {

          ws.off('open', onOpen);
          resolve(false);
        }

        ws.once('open', onOpen.bind(this));
        ws.once('close', onClose);
      });

      // The WebSocket connection failed to establish.
      if(!connected) {

        return false;
      }

      // Cleanup after ourselves if our WebSocket closes for some reason.
      ws.once('close', () => {

        this._eventsWs = null;
        ws.removeAllListeners();
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

            this.log.error('Unable to process message from the realtime update events API.');
            ws.close();

            return;
          }

          this.emit('message', packet);
        }).catch((error) => {

          this.log.error('Error processing events WebSocket message: %s.', error);
          ws.close();
        });
      };

      // Process messages as they come in. Our WebSocket client delivers binary frames as Buffers and text frames as strings, so we can normalize and start
      // decoding immediately. The inflate runs on the libuv threadpool in parallel with any other in-flight decodes.
      ws.on('message', (data: Buffer | string) => {

        enqueuePacket(decodePacket(this.log, Buffer.isBuffer(data) ? data : Buffer.from(data)));
      });
    } catch(error) {

      this.log.error('Error connecting to the realtime update events API: %s.', error);

      return false;
    }

    return true;
  }

  /**
   * Retrieve the bootstrap JSON from a UniFi Protect controller.
   *
   * @returns Promise resolving to `true` on success, `false` on failure.
   *
   * @event bootstrap - Emitted with the complete {@link ProtectNvrBootstrap} configuration when successfully retrieved. The bootstrap contains all device
   *                    configurations, user accounts, system settings, and current device states.
   * @event message   - Once the bootstrap is retrieved, the WebSocket connection is established and this event will be emitted for each real-time update
   *                    packet received from the controller.
   *
   * @remarks The bootstrap contains the complete state of the Protect controller, including:
   *
   * - All device configurations (cameras, lights, sensors, etc.)
   * - User accounts and permissions
   * - System settings and capabilities
   * - Current device states and health
   *
   * This method automatically:
   *
   * - Reconnects if the session has expired
   * - Establishes WebSocket connections for real-time events
   * - Determines administrative privileges
   * - Emits a `bootstrap` event with the configuration
   *
   * @category API Access
   */
  public async getBootstrap(): Promise<boolean> {

    // Bootstrap the controller, and attempt to retry the bootstrap if it fails.
    return this.bootstrapController(true);
  }

  // Check admin privileges.
  private checkAdminUserStatus(isFirstRun = false): boolean {

    // Get the properties we care about from the bootstrap.
    const users = this._bootstrap?.users;
    const authUserId = this._bootstrap?.authUserId;

    // Find this user, if it exists.
    const user = users?.find((x) => x.id === authUserId);

    // User doesn't exist, we're done.
    if(!user?.allPermissions) {

      return false;
    }

    // Save our prior state so we can detect role changes without having to restart.
    const oldAdminStatus = this.isAdminUser;

    // Determine if the user has administrative camera permissions.
    this._isAdminUser = user.allPermissions.some(entry => entry.startsWith('camera:') && entry.split(':')[1].split(',').includes('write'));

    // Only admin users can change certain settings. Inform the user on startup, or if we detect a role change.
    if(isFirstRun && !this.isAdminUser) {

      this.log.info('User \'%s\' requires the Super Admin role in order to change certain settings like camera RTSP stream availability.', this.username);
    } else if(!isFirstRun && (oldAdminStatus !== this.isAdminUser)) {

      this.log.info('Role change detected for user \'%s\': the Super Admin role has been %s.', this.username, this.isAdminUser ? 'enabled' : 'disabled');
    }

    return true;
  }

  /**
   * Retrieve a snapshot image from a Protect camera.
   *
   * @param device  - Protect camera device
   * @param options - Snapshot configuration options
   *
   * @returns Promise resolving to a Buffer containing the JPEG image, or `null` on failure.
   *
   * @remarks Snapshots are generated on-demand by the Protect controller. The image quality and resolution depend on the camera's capabilities and current
   *   settings. Package camera snapshots are only available on devices with dual cameras (e.g., G4 Doorbell Pro).
   *
   * The `options` parameter accepts:
   *
   * | Property | Type | Description | Default |
   * |----------|------|-------------|---------|
   * | `width` | `number` | Requested image width in pixels | Camera default |
   * | `height` | `number` | Requested image height in pixels | Camera default |
   * | `usePackageCamera` | `boolean` | Use package camera if available | `false` |
   *
   * @category API Access
   */
  public async getSnapshot(device: ProtectCameraConfig,
    options: Partial<{ width: number, height: number, usePackageCamera: boolean }> = {}): Promise<Nullable<Buffer>> {

    // We're requesting a package camera snapshot on a camera without one - we're done.
    if(options.usePackageCamera && !device.featureFlags.hasPackageCamera) {

      return null;
    }

    // Create the parameters needed for the snapshot request.
    const params = new URLSearchParams();

    // If we have details of the snapshot request, use it to request the right size.
    if(options.height !== undefined) {

      params.append('h', options.height.toString());
    }

    if(options.width !== undefined) {

      params.append('w', options.width.toString());
    }

    // Request the image from the controller.
    const response = await this.retrieve(this.getApiEndpoint(device.modelKey) + '/' + device.id + '/' + (options.usePackageCamera ? 'package-' : '') +
      'snapshot?' + params.toString(), { method: 'GET' });

    if(!response || !this.responseOk(response.statusCode)) {

      this.log.error('%s: Unable to retrieve the snapshot.', this.getFullName(device));

      return null;
    }

    let snapshot;

    try {

      snapshot = Buffer.from(await response.body.arrayBuffer());
    } catch(error) {

      this.log.error('%s: Error retrieving the snapshot image: %s', this.getFullName(device), error);

      return null;
    }

    return snapshot;
  }

  /**
   * Update a Protect device's configuration on the UniFi Protect controller.
   *
   * @typeParam DeviceType - Generic for any known Protect device type
   *
   * @param device  - Protect device to update
   * @param payload - Configuration changes to apply
   *
   * @returns Promise resolving to the updated device configuration, or `null` on failure.
   *
   * @remarks This method applies configuration changes to any Protect device. Common modifications include:
   *
   * - Camera settings (name, recording modes, motion zones)
   * - Light settings (brightness, motion activation)
   * - Sensor settings (sensitivity, mount type)
   * - Chime settings (volume, ringtones)
   *
   * **Important**: Most configuration changes require administrative privileges. The user account must have the Super Admin role assigned in UniFi Protect.
   *
   * Changes are applied immediately and persist across device reboots. The method returns the complete updated device configuration, reflecting any
   * server-side adjustments.
   *
   * @category API Access
   */
  public async updateDevice<DeviceType extends ProtectKnownDeviceTypes>(device: DeviceType,
    payload: ProtectKnownDevicePayloads): Promise<Nullable<DeviceType>> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return null;
    }

    // Only admin users can update JSON objects.
    if(!this.isAdminUser) {

      return null;
    }

    this.log.debug('%s: %s', this.getFullName(device), util.inspect(payload, { colors: true, depth: null, sorted: true }));

    // Update Protect with the new configuration.
    const response = await this.retrieve(this.getApiEndpoint(device.modelKey) + ((device.modelKey === 'nvr') ? '' : '/' + device.id), {

      body: JSON.stringify(payload),
      method: 'PATCH',
    });

    // Something happened - the retrieve call will log the error for us.
    if(!response) {

      return null;
    }

    if(!this.responseOk(response.statusCode)) {

      this.log.error('%s: Unable to configure the %s: %s.', this.getFullName(device), device.modelKey, response.statusCode);

      return null;
    }

    // We successfully updated the device configuration, return the updated device object.
    try {

      return await response.body.json() as DeviceType;
    } catch(error) {

      this.log.error('%s: Unable to parse the response from the Protect controller.', this.getFullName(device));

      return null;
    }
  }

  // Update camera channels on a supported Protect device.
  private async updateCameraChannels(device: ProtectCameraConfigInterface,
    channels: ProtectCameraChannelConfigInterface[]): Promise<Nullable<ProtectCameraConfig>> {

    // Make sure we have the permissions to modify the camera JSON.
    if(!(await this.canModifyCamera())) {

      return null;
    }

    // Update Protect with the new configuration.
    const response = await this._retrieve(this.getApiEndpoint(device.modelKey) + '/' + device.id, {

      body: JSON.stringify({ channels }),
      method: 'PATCH',
    }, { decodeResponse: false });

    // Since we took responsibility for interpreting the outcome of the fetch, we need to check for any errors.
    if(!response || !this.responseOk(response.statusCode)) {

      this.apiErrorCount++;

      if(response?.statusCode === 403) {

        this.log.error('%s: Insufficient privileges to enable RTSP on all channels. Please ensure this username has the Administrator role assigned in ' +
          'UniFi Protect.', this.getFullName(device));
      } else {

        this.log.error('%s: Unable to enable RTSP on all channels: %s.', this.getFullName(device), response?.statusCode);
      }

      // We still return our camera object if there is at least one RTSP channel enabled.
      return device;
    }

    // Since we have taken responsibility for decoding response types, we need to reset our API backoff count.
    this.apiErrorCount = 0;

    // Everything worked, save the new channel array.
    try {

      return await response.body.json() as ProtectCameraConfig;
    } catch(error) {

      this.log.error('%s: Unable to parse the response from the Protect controller.', this.getFullName(device));

      return device;
    }
  }

  /**
   * Utility method that enables all RTSP channels on a given Protect camera.
   *
   * @param device - Protect camera to modify
   *
   * @returns Promise resolving to the updated camera configuration, or `null` on failure.
   *
   * @remarks RTSP (Real Time Streaming Protocol) streams allow third-party applications to access camera feeds directly. This method enables RTSP on all
   *   available channels (resolutions) for a camera, making them accessible at:
   *
   * - High: `rtsp://[NVR_IP]:7447/[CAMERA_GUID]_0`
   * - Medium: `rtsp://[NVR_IP]:7447/[CAMERA_GUID]_1`
   * - Low: `rtsp://[NVR_IP]:7447/[CAMERA_GUID]_2`
   *
   * **Note**: Enabling RTSP requires Super Admin privileges in UniFi Protect.
   *
   * @category Utilities
   */
  public async enableRtsp(device: ProtectCameraConfigInterface): Promise<Nullable<ProtectCameraConfig>> {

    // Make sure we have the permissions to modify the camera JSON.
    if(!(await this.canModifyCamera())) {

      return null;
    }

    // Do we have any non-RTSP enabled channels? If not, we're done.
    if(!device.channels.some((channel) => !channel.isRtspEnabled)) {

      return device;
    }

    // Build a new channels array with RTSP enabled on every channel, leaving the caller's device object untouched. The controller's response from the PATCH is
    // the authoritative state.
    const channels = device.channels.map((channel) => ({ ...channel, isRtspEnabled: true }));

    // Update the camera channel JSON with our edits.
    return this.updateCameraChannels(device, channels);
  }

  /**
   * Utility method that generates a nicely formatted device information string.
   *
   * @param device     - Protect device
   * @param name       - Custom name to use (defaults to device name)
   * @param deviceInfo - Include IP and MAC address information
   *
   * @returns Formatted device string.
   *
   * @remarks Returns device information in a consistent, readable format:
   *
   * - Basic: `Device Name [Device Type]`
   * - With info: `Device Name [Device Type] (address: IP mac: MAC)`
   *
   * This method handles all Protect device types and gracefully handles missing information.
   *
   * @category Utilities
   */
  public getDeviceName(device: ProtectKnownDeviceTypes, name: string | undefined = device.name, deviceInfo = false): string {

    // Include the host address information, if we have it.
    const host = (('host' in device) && device.host) ? 'address: ' + device.host + ' ' : '';
    const type = (('marketName' in device) && device.marketName) ? device.marketName : device.type;

    // A completely enumerated device will appear as:
    // Device Name [Device Type] (address: IP address, mac: MAC address).
    return (name ?? type) + ' [' + type + ']' + (deviceInfo ? ' (' + host + 'mac: ' + device.mac + ')' : '');
  }

  /**
   * Utility method that generates a combined device and controller information string.
   *
   * @param device - Protect device
   *
   * @returns Formatted string including both controller and device information.
   *
   * @remarks Combines controller and device information for complete context: `Controller Name [Controller Type] Device Name [Device Type]`
   *
   * Useful for logging and multi-controller environments where device context is important.
   *
   * @category Utilities
   */
  public getFullName(device: ProtectKnownDeviceTypes): string {

    const deviceName = this.getDeviceName(device);

    // Returns: NVR [NVR Type] Device Name [Device Type]
    return this.name + (deviceName.length ? ' ' + deviceName : '');
  }

  /**
   * Terminate any open connection to the UniFi Protect API.
   *
   * @remarks Performs a clean shutdown of all API connections:
   *
   * - Closes WebSocket connections
   * - Destroys the HTTP connection pool
   * - Clears cached bootstrap data
   * - Resets authentication state
   *
   * Call this method when shutting down your application or switching controllers. The API can be reused after reset by calling {@link login} again.
   *
   * @category Utilities
   */
  public reset(): void {

    this._bootstrap = null;

    this._eventsWs?.close();
    this._eventsWs = null;

    if(this.nvrAddress) {

      // Cleanup any prior connection pool.
      this.agent?.destroy();

      // Create a connection pool for our HTTP requests. We want to explicitly allow the self-signed SSL certificates that ship with Protect controllers, and
      // allow up to five connections at a time with keepalive enabled for TLS session reuse and connection efficiency. Robust retry handling for transient
      // failures is provided per-request by our transport layer in _retrieve.
      this.agent = new https.Agent({ keepAlive: true, maxSockets: 5, rejectUnauthorized: false });
    }
  }

  /**
   * Clear login credentials and terminate all API connections.
   *
   * @remarks Performs a complete logout:
   *
   * - Clears authentication tokens and cookies
   * - Terminates all active connections
   * - Resets user privilege status
   * - Preserves CSRF token for future logins
   *
   * After logout, a new {@link login} call is required to use the API again.
   *
   * @category Authentication
   */
  public logout(): void {

    // Close any connection to the Protect API.
    this.reset();

    // Reset our parameters.
    this._isAdminUser = false;

    // Save our CSRF token, if we have one.
    const csrfToken = this.headers['x-csrf-token'];

    // Initialize the headers we need.
    this.headers = {};
    this.headers['content-type'] = 'application/json';
    this.headers['user-agent'] = 'unifi-protect';

    // Restore the CSRF token if we have one.
    if(csrfToken) {

      this.headers['x-csrf-token'] = csrfToken;
    }
  }

  // Utility to validate that we have the privileges we need to modify the camera JSON.
  private async canModifyCamera(): Promise<boolean> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return false;
    }

    // Only admin users can activate RTSP streams.
    if(!this.isAdminUser) {

      return false;
    }

    return true;
  }

  /**
   * Return a websocket API endpoint for the requested endpoint type.
   *
   * @param endpoint - Endpoint type (`livestream` or `talkback`)
   * @param params   - URL parameters for the endpoint
   *
   * @returns Promise resolving to the WebSocket URL, or `null` on failure.
   *
   * @remarks This method provides access to real-time WebSocket endpoints:
   *
   * ### Livestream Endpoint
   * Returns a WebSocket URL for H.264 fMP4 video streams. **Do not use directly** - use {@link createLivestream} instead for proper stream handling.
   *
   * ### Talkback Endpoint
   * Creates a two-way audio connection to cameras with speakers (doorbells, two-way audio cameras). The WebSocket accepts AAC-encoded ADTS audio streams.
   *
   * Required parameter:
   *
   * - `camera`: The camera ID to connect to
   *
   * @category API Access
   */
  public async getWsEndpoint(endpoint: 'livestream' | 'talkback', params?: URLSearchParams): Promise<Nullable<string>> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return null;
    }

    // Ask Protect to give us a URL for this websocket.
    const response = await this.retrieve(this.getApiEndpoint('websocket') + '/' + endpoint + ((params?.toString().length) ? '?' + params.toString() : ''));

    // Something went wrong, we're done here.
    if(!response || !this.responseOk(response.statusCode)) {

      // Only inform users if we have a response if we have something to say.
      if(response) {

        this.log.error('API endpoint access error: ' + response.statusCode.toString() + ' - ' + (STATUS_CODES[response.statusCode] ?? '') + '.');
      }

      return null;
    }

    try {

      const responseJson = await response.body.json() as { url: string };

      // Adjust the URL for our address.
      const responseUrl = new URL(responseJson.url);

      responseUrl.hostname = this.nvrAddress;

      // Return the URL to the websocket.
      return responseUrl.toString();
    } catch(error) {

      if(error instanceof SyntaxError) {

        this.log.error('Received syntax error while communicating with the controller. This is typically due to a controller reboot.');
      } else if((error instanceof Error) && ('code' in error) && (typeof (error as NodeJS.ErrnoException).code === 'string')) {

        this.log.error('Unknown error while communicating with the controller: %s', (error as NodeJS.ErrnoException).message);
      } else {

        this.log.error('An error occurred while communicating with the controller: %s.', error);
      }

      return null;
    }
  }

  /**
   * Execute an HTTP request to the Protect controller.
   *
   * @param url             - Full URL to request (e.g., `https://192.168.1.1/proxy/protect/api/cameras`)
   * @param options         - Request options, controlling the method and body of the request
   * @param retrieveOptions - Additional options for error handling and timeouts
   *
   * @returns Promise resolving to the Response object, or `null` on failure.
   *
   * @remarks This method provides direct access to the Protect controller API for advanced use cases not covered by the built-in methods. It handles:
   *
   * - Authentication and session management
   * - Automatic retry with exponential backoff
   * - Error logging and throttling
   * - CSRF token management
   *
   * @category API Access
   */
  public async retrieve(url: string, options: RequestOptions = { method: 'GET' }, retrieveOptions: RetrieveOptions = {}): Promise<Nullable<RequestResponse>> {

    return this._retrieve(url, options, retrieveOptions);
  }

  // Internal interface to communicating HTTP requests with a Protect controller, with error handling.
  private async _retrieve(url: string, options: RequestOptions = { method: 'GET' },
    retrieveOptions: InternalRetrieveOptions = {}): Promise<Nullable<RequestResponse>> {

    // Set our defaults unless the user has overriden them.
    retrieveOptions.decodeResponse ??= true;
    retrieveOptions.logErrors ??= true;
    retrieveOptions.timeout ??= PROTECT_API_TIMEOUT;

    // Log errors if that's what the caller requested.
    const logError = (message: string, ...parameters: unknown[]): void => {

      if(!retrieveOptions.logErrors) {

        return;
      }

      this.log.error(message, ...parameters);
    };

    let response;

    // Create a signal handler to deliver the abort operation.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), retrieveOptions.timeout);

    // Catch Protect controller server-side issues.
    try {

      const now = Date.now();

      // Throttle this after PROTECT_API_ERROR_LIMIT attempts.
      if(this.apiErrorCount >= PROTECT_API_ERROR_LIMIT) {

        // Let the user know we've got an API problem.
        if(!this._isThrottled) {

          this.apiThrottleStart = now;
          this._isThrottled = true;
          this.log.error('Throttling API calls due to errors with the %s previous attempts. Pausing communication with the Protect controller for %s minutes.',
            this.apiErrorCount++, PROTECT_API_RETRY_INTERVAL / 60);
          this.reset();

          return null;
        }

        // Check to see if we are still throttling our API calls.
        if((now - this.apiThrottleStart) < (PROTECT_API_RETRY_INTERVAL * 1000)) {

          return null;
        }

        // Inform the user that we're out of the penalty box and try again.
        this.log.error('Resuming connectivity to the UniFi Protect API after pausing for %s minutes.', PROTECT_API_RETRY_INTERVAL / 60);
        this.apiErrorCount = 0;
        this._isThrottled = false;

        if(!(await this.loginController())) {

          return null;
        }
      }

      // Execute the API request. We intentionally use our own headers so that every request uses our authenticated session (cookie, CSRF token) and connection
      // pool. The caller controls the method and body...we own the transport and identity. Transient server-side failures are retried transparently with
      // exponential backoff. PATCH is deliberately excluded from the retries...the Protect API isn't documented and we don't trust that PATCH is idempotent on
      // the controller side. A silent retry could leave us with duplicate side effects we can't see. PATCH failures bubble up through our own error counting
      // instead, so the caller gets to decide what to do about it.
      response = await request(url, {

        agent: this.agent ?? undefined,
        body: options.body,
        headers: this.headers,
        method: options.method ?? 'GET',
        retry: (options.method === 'PATCH') ? undefined :
          { factor: 2, maxRetries: 5, maxTimeout: 1500, minTimeout: 100, statusCodes: [ 429, 500, 502, 503, 504 ] },
        signal: controller.signal,
      });

      // The caller will sort through responses instead of us.
      if(!retrieveOptions.decodeResponse) {

        return response;
      }

      // Preemptively increase the error count.
      this.apiErrorCount++;

      // Bad username and password.
      if(response.statusCode === 401) {

        this.logout();
        logError('Invalid login credentials given. Please check your login and password.');

        return null;
      }

      // Insufficient privileges.
      if(response.statusCode === 403) {

        logError('Insufficient privileges for this user. Please check the roles assigned to this user and ensure it has sufficient privileges.');

        return null;
      }

      if(!this.responseOk(response.statusCode)) {

        if(PROTECT_SERVER_ERRORS.has(response.statusCode)) {

          logError('Unable to connect to the Protect controller. This is temporary and may occur during device reboots.');

          return null;
        }

        // Some other unknown error occurred.
        logError('%s - %s', response.statusCode, STATUS_CODES[response.statusCode]);

        return null;
      }

      // We're all good - return the response and we're done.
      this.apiErrorCount = 0;
      this._isThrottled = false;

      return response;
    } catch(error) {

      // Increment our API error count.
      this.apiErrorCount++;

      // We aborted the connection.
      if(controller.signal.aborted || ((error instanceof Error) && (error.name === 'AbortError'))) {

        logError('Protect controller is taking too long to respond to a request. This error can usually be safely ignored.');

        return null;
      }

      // Map the more common network errors to something more user-friendly.
      const cause = ((error instanceof Error) && ('code' in error) && (typeof (error as NodeJS.ErrnoException).code === 'string')) ?
        error as NodeJS.ErrnoException : null;

      if(cause) {

        switch(cause.code) {

          case 'ECONNREFUSED':
          case 'EHOSTDOWN':

            logError('Connection refused.');

            break;

          case 'ECONNRESET':

            logError('Network connection to Protect controller has been reset.');

            break;

          case 'ENOTFOUND':

            if(this.nvrAddress) {

              logError('Hostname or IP address not found: %s. Please ensure the address you configured for this UniFi Protect controller is correct.',
                this.nvrAddress);
            } else {

              logError('No hostname or IP address provided.');
            }

            break;

          case 'ETIMEDOUT':

            logError('Connection timed out.');

            break;

          default:

            // If we're logging when we have an error, do so.
            logError('Error: %s | %s.', cause.code, cause.message);

            break;
        }

        return null;
      }

      logError('Unknown error: %s', util.inspect(error, { colors: true, depth: null, sorted: true }));

      return null;
    } finally {

      // Clear out our response timeout.
      clearTimeout(timer);
    }
  }

  // Utility function for logging connection retries.
  private logRetry(logMessage: string, isRetry: boolean): void {

    // If we're over the API limit, no need to continue indicating errors since we already inform users we're throttling API calls.
    if(this.apiErrorCount >= PROTECT_API_ERROR_LIMIT) {

      return;
    }

    // If we're retrying, only log when debugging.
    if(isRetry) {

      this.log.debug('%s Retrying.', logMessage);
    } else {

      this.log.error(logMessage);
    }
  }

  /**
   * Determines whether an HTTP status code represents a successful response.
   *
   * @param code - HTTP status code to check
   *
   * @returns `true` if code is 2xx, `false` otherwise.
   *
   * @remarks Validates HTTP response codes according to standard conventions:
   *
   * - 2xx codes (200-299) indicate success
   * - All other codes indicate failure
   * - `undefined` is treated as failure
   *
   * @category Utilities
   */
  public responseOk(code?: number): boolean {

    return (code !== undefined) && (code >= 200) && (code < 300);
  }

  /**
   * Return a new instance of the Protect livestream API.
   *
   * @returns New livestream API instance.
   *
   * @remarks The livestream API provides direct access to camera H.264 fMP4 streams, enabling:
   *
   * - Real-time video streaming
   * - Stream recording and processing
   * - Integration with video processing pipelines
   * - Low-latency video access
   *
   * Unlike RTSP streams, livestreams are delivered over WebSockets with minimal latency and don't require additional authentication.
   *
   * @category API Access
   */
  public createLivestream(): ProtectLivestream {

    return new ProtectLivestream(this, this.log);
  }

  /**
   * Return an API endpoint URL for the requested endpoint type.
   *
   * @param endpoint - Endpoint type to retrieve
   *
   * @returns Full URL to the requested endpoint.
   *
   * @remarks Generates properly formatted URLs for Protect API endpoints:
   *
   * | Endpoint | Path | Description |
   * |----------|------|-------------|
   * | `bootstrap` | `/proxy/protect/api/bootstrap` | Complete system configuration |
   * | `camera` | `/proxy/protect/api/cameras` | Camera management |
   * | `chime` | `/proxy/protect/api/chimes` | Chime device management |
   * | `light` | `/proxy/protect/api/lights` | Light device management |
   * | `login` | `/api/auth/login` | Authentication endpoint |
   * | `nvr` | `/proxy/protect/api/nvr` | NVR configuration |
   * | `self` | `/api/users/self` | Current user information |
   * | `sensor` | `/proxy/protect/api/sensors` | Sensor device management |
   * | `websocket` | `/proxy/protect/api/ws` | WebSocket endpoints |
   * | `viewer` | `/proxy/protect/api/viewers` | Viewport device management |
   *
   * @category API Access
   */
  public getApiEndpoint(endpoint: ProtectApiEndpoint): string {

    // Endpoint lookup table mapping each endpoint identifier to its URL path components. Most endpoints use the standard /proxy/protect/api/ prefix...login and
    // self use /api/ because they target UniFi OS authentication rather than the Protect application.
    const endpoints: Record<ProtectApiEndpoint, { prefix: string, suffix: string }> = {

      bootstrap: { prefix: '/proxy/protect/api/', suffix: 'bootstrap' },
      camera: { prefix: '/proxy/protect/api/', suffix: 'cameras' },
      chime: { prefix: '/proxy/protect/api/', suffix: 'chimes' },
      light: { prefix: '/proxy/protect/api/', suffix: 'lights' },
      login: { prefix: '/api/', suffix: 'auth/login' },
      nvr: { prefix: '/proxy/protect/api/', suffix: 'nvr' },
      self: { prefix: '/api/', suffix: 'users/self' },
      sensor: { prefix: '/proxy/protect/api/', suffix: 'sensors' },
      viewer: { prefix: '/proxy/protect/api/', suffix: 'viewers' },
      websocket: { prefix: '/proxy/protect/api/', suffix: 'ws' },
    };

    const { prefix, suffix } = endpoints[endpoint];

    return 'https://' + this.nvrAddress + prefix + suffix;
  }

  /**
   * Access the Protect controller bootstrap JSON.
   *
   * @returns Bootstrap configuration if available, `null` otherwise.
   *
   * @remarks The bootstrap must be retrieved via {@link getBootstrap} before accessing this property. The bootstrap contains the complete system state and is
   *   automatically updated when configuration changes occur.
   *
   * @see {@link getBootstrap} to retrieve the bootstrap configuration
   * @see {@link ProtectNvrBootstrap} for the complete data structure
   *
   * @category API Access
   */
  public get bootstrap(): ProtectNvrBootstrapData {

    return this._bootstrap;
  }

  /**
   * Check if the current user has administrative privileges.
   *
   * @returns `true` if the user has Super Admin role, `false` otherwise.
   *
   * @remarks Administrative privileges are required for:
   *
   * - Modifying device configurations
   * - Enabling/disabling RTSP streams
   * - Changing system settings
   * - Managing user accounts
   *
   * The privilege level is determined during login and updated on each bootstrap.
   *
   * @category Utilities
   */
  public get isAdminUser(): boolean {

    return this._isAdminUser;
  }

  /**
   * Check if API calls are currently throttled due to errors.
   *
   * @returns `true` if throttled, `false` otherwise.
   *
   * @remarks The API implements automatic throttling after repeated errors to prevent overwhelming the controller. During throttling:
   *
   * - API calls return `null` immediately
   * - No network requests are made
   * - Throttling automatically clears after the retry interval
   *
   * Default throttling occurs after 10 consecutive errors for 5 minutes.
   *
   * @category Utilities
   */
  public get isThrottled(): boolean {

    return this._isThrottled;
  }

  /**
   * Get a formatted name for the Protect controller.
   *
   * @returns Controller name in format: `Name [Type]` or just the address if not bootstrapped.
   *
   * @remarks Returns a human-readable controller identifier. After bootstrap, includes the controller's configured name and model type. Before bootstrap,
   *   returns the hostname or IP address used for connection.
   *
   * @category Utilities
   */
  public get name(): string {

    // Our NVR string, if it exists, appears as `NVR [NVR Type]`. Otherwise, we appear as `NVR hostname or IP address`.
    if(this._bootstrap?.nvr) {

      return (this._bootstrap.nvr.name ?? this._bootstrap.nvr.marketName) + ' [' + this._bootstrap.nvr.marketName + ']';
    }

    return this.nvrAddress;
  }
}
