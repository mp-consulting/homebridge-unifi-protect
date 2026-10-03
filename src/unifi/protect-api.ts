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
import { type InternalRetrieveOptions, ProtectApiHttp, type RequestOptions, type RetrieveOptions, isResponseOk } from './protect-api-http.js';
import { ProtectTlsPin, type ProtectTlsPinOptions, createProtectAgent } from './protect-api-tls.js';
import { EventEmitter } from 'node:events';
import { ProtectApiSession } from './protect-api-session.js';
import type { ProtectEventPacket } from './protect-api-events.js';
import { ProtectEventsChannel } from './protect-api-events-channel.js';
import { ProtectLivestream } from './protect-api-livestream.js';
import type { ProtectLogging } from './protect-logging.js';
import type { RequestResponse } from '../lib/request.js';
import { STATUS_CODES } from 'node:http';
import type https from 'node:https';
import util from 'node:util';

export type { RequestOptions, RetrieveOptions } from './protect-api-http.js';
export { PROTECT_TLS_PIN_MISMATCH, type ProtectTlsPinOptions, normalizeFingerprint } from './protect-api-tls.js';

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
 * Options to tailor the behavior of the Protect API client.
 *
 * @property {boolean} [verifyTls=false] - Validate the controller's TLS certificate against the system's trusted certificate authorities. Defaults to `false`
 *                                         since UniFi controllers use self-signed certificates. When `false`, the controller's certificate is instead pinned on
 *                                         first use (see {@link ProtectTlsPinOptions}) and connections presenting a different certificate are refused.
 */
export interface ProtectApiOptions extends ProtectTlsPinOptions {

  verifyTls?: boolean;
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
 * - Trust-on-first-use pinning of the controller's TLS certificate when strict validation is disabled
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
  private _isAdminUser: boolean;
  private _tlsAgent: Nullable<https.Agent>;
  private _verifyTls: boolean;
  private agent: Nullable<https.Agent>;
  private readonly events: ProtectEventsChannel;
  private readonly http: ProtectApiHttp;
  private log: ProtectLogging;
  private readonly pin: ProtectTlsPin;
  private readonly session: ProtectApiSession;

  /**
   * Create an instance of the UniFi Protect API.
   *
   * @param log     - Custom logging implementation.
   * @param options - Options to tailor the API client's behavior. `verifyTls` enables strict TLS certificate validation of the controller - it defaults to
   *                  `false` since UniFi controllers ship with self-signed certificates. When strict validation is off, the controller's certificate is pinned
   *                  on first use: `pinnedFingerprint` supplies a previously trusted fingerprint, `onFingerprint` is called when a new one is pinned so it
   *                  can be persisted, and `onFingerprintMismatch` is called when the controller presents a different certificate.
   *
   * @defaultValue Console logging to stdout/stderr
   *
   * @remarks The logging interface allows you to integrate the API with your application's logging system. By default, errors and warnings are logged to the
   *   console, while debug messages are suppressed.
   *
   * @category Constructor
   */
  constructor(log?: ProtectLogging, options: ProtectApiOptions = {}) {

    // Initialize our parent.
    super();

    // UniFi controllers ship with self-signed certificates, so we skip certificate authority validation by default and pin the certificate on first use
    // instead. Setups with proper certificates can opt in to strict validation.
    this._verifyTls = options.verifyTls ?? false;

    // If we didn't get passed a logging parameter, by default we log to the console.
    log ??= {

      debug: (): void => {},
      error: (message: string, ...parameters: unknown[]): void => console.error(message, ...parameters),
      info: (message: string, ...parameters: unknown[]): void => console.log(message, ...parameters),
      warn: (message: string, ...parameters: unknown[]): void => console.log(message, ...parameters),
    };

    this._bootstrap = null;
    this._isAdminUser = false;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => log.debug(this.name + ': ' + message, ...parameters),
      error: (message: string, ...parameters: unknown[]): void => log.error(this.name + ': API error: ' + message, ...parameters),
      info: (message: string, ...parameters: unknown[]): void => log.info(this.name + ': ' + message, ...parameters),
      warn: (message: string, ...parameters: unknown[]): void => log.warn(this.name + ': ' + message, ...parameters),
    };

    this._tlsAgent = null;
    this.agent = null;

    // When strict validation is off, we pin the controller's certificate on first use and refuse connections that present a different certificate thereafter.
    this.pin = new ProtectTlsPin(this.log, options);

    // Our authenticated session: credentials, cookie, and CSRF token.
    this.session = new ProtectApiSession({

      loginEndpoint: () => this.getApiEndpoint('login'),
      logout: () => this.logout(),
      retrieve: async (url, requestOptions, retrieveOptions) => this.retrieve(url, requestOptions, retrieveOptions),
    });

    // Our HTTP transport, including throttling when the controller is struggling.
    this.http = new ProtectApiHttp({

      agent: () => this.agent,
      headers: () => this.session.headers,
      log: this.log,
      login: async () => this.session.login(),
      logout: () => this.logout(),
      nvrAddress: () => this.session.nvrAddress,
      reset: () => this.reset(),
    });

    // Our realtime update events channel.
    this.events = new ProtectEventsChannel({

      cookie: () => this.session.cookie,
      emitMessage: (packet: ProtectEventPacket) => this.emit('message', packet),
      isLoggedIn: () => this.session.isLoggedIn,
      lastUpdateId: () => this._bootstrap?.lastUpdateId ?? '',
      log: this.log,
      login: async () => this.session.login(),
      nvrAddress: () => this.session.nvrAddress,
      tlsAgent: () => this.tlsAgent,
      verifyTls: () => this._verifyTls,
    });
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

    this.session.setCredentials(nvrAddress, username, password);

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

    return this.session.login();
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

    return this.events.connect();
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
    this._isAdminUser = user.allPermissions.some(entry => entry.startsWith('camera:') && (entry.split(':')[1]?.split(',').includes('write') ?? false));

    // Only admin users can change certain settings. Inform the user on startup, or if we detect a role change.
    if(isFirstRun && !this.isAdminUser) {

      this.log.info('User \'%s\' requires the Super Admin role in order to change certain settings like camera RTSP stream availability.', this.session.username);
    } else if(!isFirstRun && (oldAdminStatus !== this.isAdminUser)) {

      this.log.info('Role change detected for user \'%s\': the Super Admin role has been %s.', this.session.username, this.isAdminUser ? 'enabled' : 'disabled');
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
   * | `timeout` | `number` | Milliseconds to wait for the controller before giving up | `3500` |
   *
   * `timeout` matters when the caller is itself working against a deadline - HomeKit snapshot requests, for instance, must return within five seconds
   * regardless of how long the controller takes. Without it, the default response timeout can outlast the caller's own budget.
   *
   * @category API Access
   */
  public async getSnapshot(device: ProtectCameraConfig,
    options: { width?: number | undefined, height?: number | undefined, timeout?: number, usePackageCamera?: boolean } = {}): Promise<Nullable<Buffer>> {

    // Log us in if needed.
    if(!(await this.loginController())) {

      return null;
    }

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

    // Request the image from the controller, honoring the caller's timeout if they gave us one.
    const response = await this.retrieve(this.getApiEndpoint(device.modelKey) + '/' + device.id + '/' + (options.usePackageCamera ? 'package-' : '') +
      'snapshot?' + params.toString(), { method: 'GET' }, (options.timeout === undefined) ? {} : { timeout: options.timeout });

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

      this.http.breaker.recordFailure();

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
    this.http.breaker.recordSuccess();

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

    // Close the events WebSocket and cancel any pending reconnect attempt.
    this.events.close();

    if(this.session.nvrAddress) {

      // Cleanup any prior connection pool.
      this.agent?.destroy();

      // Create a connection pool for our HTTP requests. Unless strict certificate validation has been requested, we verify the controller's self-signed
      // certificate against our trust-on-first-use pin before any request data is sent. We allow up to five connections at a time with keepalive enabled for
      // TLS session reuse and connection efficiency. Robust retry handling for transient failures is provided per-request by our transport layer.
      this.agent = createProtectAgent(this._verifyTls, this.pin, { keepAlive: true, maxSockets: 5 });
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

    // Clear our session, preserving our CSRF token, if we have one.
    this.session.clear();
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

      responseUrl.hostname = this.session.nvrAddress;

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

    return this.http.retrieve(url, options, retrieveOptions);
  }

  // Utility function for logging connection retries.
  private logRetry(logMessage: string, isRetry: boolean): void {

    // If we're over the API limit, no need to continue indicating errors since we already inform users we're throttling API calls.
    if(this.http.breaker.isOverLimit) {

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

    return isResponseOk(code);
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

    return 'https://' + this.session.nvrAddress + prefix + suffix;
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

    return this.http.breaker.isThrottled;
  }

  /**
   * Utility method that returns whether TLS certificate validation is enabled for connections to the Protect controller.
   *
   * @returns Returns `true` when the controller's TLS certificate is being validated, `false` otherwise.
   *
   * @remarks Configured at construction time through {@link ProtectApiOptions}. Consumers that open their own connections to the controller (e.g. the
   *   livestream API) use this to match the client's TLS posture.
   *
   * @category Utilities
   */
  public get verifyTls(): boolean {

    return this._verifyTls;
  }

  /**
   * Utility method that returns the SHA-256 fingerprint of the controller certificate we've pinned, if any.
   *
   * @returns Returns the colon-separated, uppercase hex fingerprint, or `undefined` if no certificate has been pinned yet or strict validation is enabled.
   *
   * @category Utilities
   */
  public get tlsFingerprint(): string | undefined {

    return this._verifyTls ? undefined : this.pin.fingerprint;
  }

  /**
   * Utility method that returns an HTTPS agent suitable for additional connections to the Protect controller, such as WebSockets.
   *
   * @returns Returns an agent that applies the same certificate policy as our API requests - strict validation when `verifyTls` is enabled, and our
   *   trust-on-first-use certificate pin otherwise. Certificate verification completes before the agent hands the connection to a request, so no request
   *   data is sent to an unverified controller.
   *
   * @remarks The agent doesn't pool connections, making it suitable for long-lived connections like livestreams and talkback.
   *
   * @category Utilities
   */
  public get tlsAgent(): https.Agent {

    this._tlsAgent ??= createProtectAgent(this._verifyTls, this.pin, { keepAlive: false });

    return this._tlsAgent;
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

    return this.session.nvrAddress;
  }
}
