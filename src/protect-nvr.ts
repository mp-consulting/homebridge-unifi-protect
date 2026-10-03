/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import type { API, HAP, PlatformAccessory } from 'homebridge';
import { type HomebridgePluginLogging, MqttClient, type Nullable, retry, sanitizeName, sleep } from './lib/index.js';
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_CONTROLLER_REFRESH_INTERVAL, PROTECT_CONTROLLER_RETRY_INTERVAL } from './settings.js';
import { ProtectCamera, ProtectChime, type ProtectDevice, ProtectDoorbell, ProtectLight, ProtectLiveviews, ProtectNvrSystemInfo, ProtectSensor,
  ProtectViewer } from './devices/index.js';
import type { ProtectNvrBootstrap, ProtectNvrConfig } from './unifi/index.js';
import type { ProtectDeviceCategory, ProtectDeviceConfigTypes, ProtectDeviceTypes, ProtectDevices } from './protect-types.js';
import { APIEvent } from 'homebridge';
import { ProtectApi } from './unifi/index.js';
import { accessoryContext } from './devices/protect-accessory-context.js';
import { ProtectDeviceCategories } from './protect-types.js';
import { ProtectEvents } from './protect-events.js';
import type { ProtectFeatureOptionKey, ProtectNvrOptions } from './protect-options.js';
import type { ProtectPlatform } from './protect-platform.js';
import { ProtectPlaylistServer } from './protect-playlist.js';
import util from 'node:util';

// Retrieve the device array from a bootstrap for a given category.
function getBootstrapDevices(bootstrap: ProtectNvrBootstrap, category: ProtectDeviceCategory): ProtectDeviceConfigTypes[] {

  return bootstrap[`${category}s`];
}

export class ProtectNvr {

  private api: API;
  public readonly config: ProtectNvrOptions;
  private deviceRemovalQueue: Record<string, number>;
  public readonly configuredDevices: Record<string, ProtectDevices | undefined>;
  private readonly devicesById: Map<string, ProtectDevices>;
  public readonly events: ProtectEvents;
  private featureLog: Record<string, boolean>;
  private hap: HAP;
  private lastAccessoryCacheState: string | undefined;
  private liveviews: Nullable<ProtectLiveviews>;
  public logApiErrors: boolean;
  public readonly log: HomebridgePluginLogging;
  public mqtt: Nullable<MqttClient>;
  private name: string;
  public readonly platform: ProtectPlatform;
  public systemInfo: Nullable<ProtectNvrSystemInfo>;
  public ufp: ProtectNvrConfig;
  public readonly ufpApi: ProtectApi;
  private unsupportedDevices: Record<string, boolean>;

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {

    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = {};
    this.deviceRemovalQueue = {};
    this.devicesById = new Map();
    this.featureLog = {};
    this.hap = this.api.hap;
    this.lastAccessoryCacheState = undefined;
    this.liveviews = null;
    this.logApiErrors = true;
    this.mqtt = null;
    this.name = nvrOptions.name ?? nvrOptions.address;
    this.platform = platform;
    this.systemInfo = null;
    this.ufp = {} as ProtectNvrConfig;
    this.unsupportedDevices = {};

    // Configure our API logging.
    const ufpLog = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => {

        if(this.logApiErrors) {

          this.platform.log.error(util.format(message, ...parameters));
        }
      },
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(message, ...parameters)),
    };

    // Initialize our connection to the UniFi Protect API. Certificate authority validation is off by default since UniFi controllers ship with self-signed
    // certificates - instead, we pin the controller's certificate the first time we see it and refuse to talk to anything presenting a different certificate
    // afterwards. Setups with proper certificates can opt in to strict validation through the verifyTls controller option.
    this.ufpApi = new ProtectApi(ufpLog, {

      onFingerprint: (fingerprint: string): void => this.platform.tlsPins.set(this.config.address, fingerprint),
      onFingerprintMismatch: (): void => this.log.error('If you have intentionally replaced or regenerated the certificate on this controller, remove the entry ' +
        'for %s from %s and restart Homebridge to trust the new certificate.', this.config.address, this.platform.tlsPins.filename),
      pinnedFingerprint: this.config.verifyTls ? undefined : this.platform.tlsPins.get(this.config.address),
      verifyTls: this.config.verifyTls === true,
    });

    // Configure our controller logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(this.name + ': ' + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => this.platform.log.error(util.format(this.name + ': ' + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(this.name + ': ' + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(this.name + ': ' + message, ...parameters)),
    };

    // Initialize our UniFi Protect event handler.
    this.events = new ProtectEvents(this);

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {

      return;
    }

    // Make sure we cleanup any remaining streaming sessions on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {

      for(const protectCamera of this.devices('camera')) {

        protectCamera.log.debug('Shutting down all video stream processes.');
        protectCamera.stream?.shutdown();
      }

      // Release the controller-level listeners held by our system information accessory.
      this.systemInfo?.cleanup();
    });
  }

  // Retrieve the bootstrap configuration from the Protect controller.
  private async bootstrapNvr(): Promise<boolean> {

    // Attempt to bootstrap the controller until we're successful.
    await retry(async () => this.ufpApi.getBootstrap(), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);

    return !!this.ufpApi.bootstrap;
  }

  // Initialize our connection to the UniFi Protect controller.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. Let the user know that we're done here.
    if(!this.hasFeature('Device')) {

      this.log.info('Disabling this UniFi Protect controller.');

      return;
    }

    // Attempt to login to the Protect controller, retrying at reasonable intervals. This accounts for cases where the Protect controller or the network
    // connection may not be fully available when we startup.
    await retry(async () => this.ufpApi.login(this.config.address, this.config.username, this.config.password), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);

    // Now, let's get the bootstrap configuration from the Protect controller.
    for(let count = 0; !this.ufpApi.bootstrap && (count < 5); count++) {

       
      await this.bootstrapNvr();
    }

    // Failsafe against an unresponsive controller.
    if(!this.ufpApi.bootstrap) {

      this.log.error('Unable to initialize. This may be due to the Protect controller rebooting or becoming unavailable.');

      return;
    }

    // Save the bootstrap to ease our device initialization below.
    const bootstrap = this.ufpApi.bootstrap;

    // Set our NVR configuration from the controller.
    this.ufp = bootstrap.nvr;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.config.name ?? this.ufpApi.name;

    // If we are running an unsupported version of UniFi Protect, we're done.
    if(parseInt(this.ufp.version) < 6) {

      this.log.error('This version of HBUP requires running UniFi Protect v6.0 or above using the official Protect release channel only.');
      this.ufpApi.logout();

      return;
    }

    // We successfully logged in.
    this.log.info('Connected to %s (UniFi Protect %s running on UniFi OS %s).', this.config.address, this.ufp.version, this.ufp.firmwareVersion);

    // Now that we know the NVR configuration, check to see if this Protect controller is disabled.
    if(!this.hasFeature('Device')) {

      this.ufpApi.logout();
      this.log.info('Disabling this UniFi Protect controller in HomeKit.');

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to
      // notify us when all the cached accessories are loaded at startup.
      await sleep(30 * 1000);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically
      // caught when they are restored.
      this.platform.accessories.filter(accessory => accessoryContext(accessory).nvr === this.ufp.mac)
        .map(accessory => this.removeHomeKitDevice(accessory, true));

      return;
    }

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Initialize our NVR system information.
    this.systemInfo = new ProtectNvrSystemInfo(this);

    // Initialize MQTT, if needed.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic, this.log, undefined, { verifyTls: this.config.mqttVerifyTls !== false });
    }

    // Initialize our playlist service, if enabled.
    if(this.hasFeature('Nvr.Service.Playlist')) {

      new ProtectPlaylistServer(this.ufpApi, this.log, {

        address: this.config.playlistAddress,
        port: this.getFeatureNumber('Nvr.Service.Playlist') ?? undefined,
        token: this.config.playlistToken,
      });
    }

    // Inform the user about the devices we see.
    for(const device of [ this.ufp, ...bootstrap.cameras, ...bootstrap.chimes, ...bootstrap.lights, ...bootstrap.sensors, ...bootstrap.viewers ]) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if((device.modelKey !== 'nvr') && (device.isAdoptedByOther || device.isAdopting || !device.isAdopted)) {

        continue;
      }

      this.log.info('Discovered %s: %s.', device.modelKey, this.ufpApi.getDeviceName(device, device.name ?? device.marketName, true));
    }

    // Bootstrap refresh loop.
    const bootstrapRefresh = (): void => {

      // Sleep until it's time to bootstrap again.
      setTimeout(() => void this.bootstrapNvr(), PROTECT_CONTROLLER_REFRESH_INTERVAL * 1000);
    };

    // Sync the Protect controller's devices with HomeKit.
    const syncUfpHomeKit = (): void => {

      // Sync status and check for any new or removed accessories.
      this.discoverAndSyncAccessories();

      // Refresh the accessory cache, but only when something we persist has actually changed. Homebridge writes the entire accessory cache to disk
      // synchronously each time we ask it to, and a periodic bootstrap refresh rarely changes anything.
      const cacheState = this.accessoryCacheState();

      if(cacheState !== this.lastAccessoryCacheState) {

        this.lastAccessoryCacheState = cacheState;
        this.api.updatePlatformAccessories(this.platform.accessories);
      }
    };

    // Initialize our Protect controller device sync.
    syncUfpHomeKit();

    // Let's set a listener to wait for bootstrap events to occur so we can keep ourselves in sync with the Protect controller.
    this.ufpApi.on('bootstrap', () => {

      // Sync our device view.
      syncUfpHomeKit();

      // Refresh our bootstrap.
      bootstrapRefresh();
    });

    // Kickoff our first round of bootstrap refreshes to ensure we stay in sync.
    bootstrapRefresh();
  }

  // Create instances of Protect device types in our plugin.
  private addProtectDevice(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes): Nullable<ProtectDevice> {

    let protectDevice: ProtectDevices;

    // Our device configuration types form a discriminated union on modelKey, so each case below has the device configuration narrowed to the right type.
    switch(device.modelKey) {

      case 'camera':

        // We have a UniFi Protect camera or doorbell.
        protectDevice = device.featureFlags.isDoorbell ? new ProtectDoorbell(this, device, accessory) : new ProtectCamera(this, device, accessory);

        break;

      case 'chime':

        // We have a UniFi Protect chime.
        protectDevice = new ProtectChime(this, device, accessory);

        break;

      case 'light':

        // We have a UniFi Protect light.
        protectDevice = new ProtectLight(this, device, accessory);

        break;

      case 'sensor':

        // We have a UniFi Protect sensor.
        protectDevice = new ProtectSensor(this, device, accessory);

        break;

      case 'viewer':

        // We have a UniFi Protect viewer.
        protectDevice = new ProtectViewer(this, device, accessory);

        break;

      default: {

        const unknown: { modelKey: string, name?: string, marketName?: string } = device;

        this.log.error('Unknown device class %s detected for %s.', unknown.modelKey, unknown.name ?? unknown.marketName);

        return null;
      }
    }

    // Track our newly created device, both by accessory and by Protect device identifier.
    this.configuredDevices[accessory.UUID] = protectDevice;
    this.devicesById.set(device.id, protectDevice);

    // Return our newly created device.
    return protectDevice;
  }

  // Add a newly detected Protect device to HomeKit.
  public addHomeKitDevice(device: ProtectDeviceConfigTypes): boolean {

    // If we have no MAC address, name, or this camera isn't being managed by this Protect controller, we're done.
    if(!this.ufp.mac || !device.mac || device.isAdoptedByOther || !device.isAdopted) {

      return false;
    }

    // We only support certain devices.
    if(!(ProtectDeviceCategories as readonly string[]).includes(device.modelKey)) {

      // If we've already informed the user about this one, we're done.
      if(this.unsupportedDevices[device.mac]) {

        return false;
      }

      // Notify the user we see this device, but we aren't adding it to HomeKit.
      this.unsupportedDevices[device.mac] = true;

      this.log.info('UniFi Protect device type %s is not currently supported, ignoring: %s.', device.modelKey, this.ufpApi.getDeviceName(device));

      return false;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    // See if we already know about this accessory.
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature('Device', device)) {

      if(accessory) {

        this.removeHomeKitDevice(accessory, true);
      }

      return false;
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(sanitizeName(device.name ?? device.marketName), uuid);

      this.log.info('%s: Adding %s to HomeKit%s.', this.ufpApi.getDeviceName(device), device.modelKey,
        this.hasFeature('Device.Standalone', device) ? ' as a standalone device' : '');

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature('Device.Standalone', device)) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Setup the accessory as a new Protect device in HBUP if we haven't configured it yet.
    if(!this.configuredDevices[accessory.UUID]) {

      this.addProtectDevice(accessory, device);

      return true;
    }

    // Update the configuration on an existing Protect device.
    this.events.emit('updateEvent', { header: { action: 'update', hbupBootstrap: true, id: device.id, modelKey: device.modelKey }, payload: device });

    return true;
  }

  // Discover and sync UniFi Protect devices between HomeKit and the Protect controller.
  private discoverAndSyncAccessories(): boolean {

    // If the Protect controller's not bootstrapped, or it's experiencing a meltdown, we're done.
    if(!this.ufpApi.bootstrap || this.ufpApi.isThrottled) {

      // Clear out the device removal queue since we can't trust the Protect controller at the moment.
      if(Object.keys(this.deviceRemovalQueue).length) {

        this.log.info('Communication with the controller has been lost. Clearing out the device removal queue as a precaution until connectivity returns.');
        this.deviceRemovalQueue = {};
      }

      return false;
    }

    // Iterate through the list of device categories we know about and add them to HomeKit.
    ProtectDeviceCategories.map(category => this.ufpApi.bootstrap &&
      getBootstrapDevices(this.ufpApi.bootstrap, category).map(device => this.addHomeKitDevice(device)));

    // Remove Protect devices that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our chime accessories.
    this.devices('chime').map(chime => chime.updateDevice());

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    // Update our viewer accessories.
    this.devices('viewer').map(viewer => viewer.updateDevice());

    // Update our device information.
    this.devicelist.map(device => device.configureInfo());

    return true;
  }

  // Cleanup removed Protect devices from HomeKit.
  private cleanupDevices(): void {

    // Process the device removal queue before we do anything else.
    this.platform.accessories.filter(accessory => Object.keys(this.deviceRemovalQueue).includes(accessory.UUID)).map(accessory =>
      this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test('Device',
        ((accessory.getService(this.hap.Service.AccessoryInformation)
          ?.getCharacteristic(this.hap.Characteristic.SerialNumber).value) ?? '') as string, this.ufp.mac)));

    // Cleanup our accessories.
    for(const accessory of this.platform.accessories.filter(x => accessoryContext(x).nvr === this.ufp.mac)) {

      const protectDevice = this.configuredDevices[accessory.UUID];

      // Check to see if we have an orphan - where we haven't configured this in the plugin, but the accessory still
      // exists in HomeKit. One example of when this might happen is when Homebridge might be shutdown and a camera is
      // then removed. When we start back up, the camera still exists in HomeKit but not in Protect. We catch those
      // orphan devices here.
      if(!protectDevice) {

        this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test('Device',
          ((accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value) ?? '') as string));

        continue;
      }

      // If we don't have the Protect bootstrap JSON available, we're done. We need to know what's on the Protect
      // controller in order to determine what to do with the accessories we know about.
      if(!this.ufpApi.bootstrap) {

        continue;
      }

      // Check to see if the device still exists on the Protect controller and the user has not chosen to hide it,
      // or the user has chosen to make this a standalone accessory rather than a bridged one.
      if(getBootstrapDevices(this.ufpApi.bootstrap, protectDevice.ufp.modelKey).some(x => x.mac === protectDevice.ufp.mac) &&
        protectDevice.hints.enabled && ((accessory._associatedHAPAccessory.bridged && !protectDevice.hints.standalone) ||
         (!accessory._associatedHAPAccessory.bridged && protectDevice.hints.standalone))) {

        // In case we have previously queued a device for deletion, let's remove it from the queue since it's reappeared.
        delete this.deviceRemovalQueue[protectDevice.accessory.UUID];

        continue;
      }

      // Remove and then add the device back to HomeKit if we're really just transitioning between bridged and standalone devices.
      if(protectDevice.hints.enabled && ((!accessory._associatedHAPAccessory.bridged && !protectDevice.hints.standalone) ||
        (accessory._associatedHAPAccessory.bridged && protectDevice.hints.standalone))) {

        this.removeHomeKitDevice(accessory, true);
        this.addHomeKitDevice(protectDevice.ufp);

        continue;
      }

      // Process the device removal.
      this.removeHomeKitDevice(accessory, !this.hasFeature('Device', protectDevice.ufp));
    }
  }

  // Remove an individual Protect accessory from HomeKit.
  public removeHomeKitDevice(accessory: PlatformAccessory, noRemovalDelay = false): void {

    const context = accessoryContext(accessory);

    // Ensure that this accessory hasn't already been removed.
    if(!this.platform.accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Protect controller we're interested in.
    if(context.nvr !== this.ufp.mac) {

      return;
    }

    // The NVR system information accessory is handled elsewhere.
    if(context.systemInfo) {

      return;
    }

    // Liveview-centric accessories are handled elsewhere.
    if(context.liveview || accessory.getService(this.hap.Service.SecuritySystem)) {

      return;
    }

    // We only store MAC addresses on devices that exist on the Protect controller. Any other accessories created are
    // ones we created ourselves and are managed elsewhere, with one exception - package cameras. If we have a matching
    // parent camera for the package camera, we're done here. Package cameras are dealt with when we remove the parent
    // camera. If the parent doesn't exist, this is an orphan that we need to remove.
    if(!context.mac &&
      (!context.packageCamera || (this.platform.accessories.some(x => accessoryContext(x).mac === context.packageCamera)))) {

      return;
    }

    const delayInterval = this.getFeatureNumber('Nvr.DelayDeviceRemoval') ?? 0;

    // For certain use cases, we may want to defer removal of a Protect device where Protect may lose track of
    // devices for a brief period of time. This prevents a potential back-and-forth where devices are removed
    // momentarily only to be readded later.
    if(!noRemovalDelay && delayInterval) {

      const queuedTime = this.deviceRemovalQueue[accessory.UUID];

      // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
      if(!queuedTime) {

        this.deviceRemovalQueue[accessory.UUID] = Date.now();

        this.log.info('%s: Delaying device removal for at least %s second%s.', accessory.displayName, delayInterval, delayInterval > 1 ? 's' : '');

        return;
      }

      // Is it time to process this device removal?
      if((delayInterval * 1000) > (Date.now() - queuedTime)) {

        return;
      }
    }

    // Cleanup after ourselves.
    delete this.deviceRemovalQueue[accessory.UUID];

    // Grab our instance of the Protect device, if it exists.
    const protectDevice = this.configuredDevices[accessory.UUID];

    // See if we can pull the device's configuration details from our Protect device instance or the controller.
    const bootstrap = this.ufpApi.bootstrap;
    const device = protectDevice?.ufp ??
      (bootstrap ? ProtectDeviceCategories.flatMap(category => getBootstrapDevices(bootstrap, category)) : []).find(d => d.mac === context.mac);

    this.log.info('%s: Removing %s from HomeKit.%s',
      device ? this.ufpApi.getDeviceName(device) : protectDevice?.accessoryName ?? accessory.displayName,
      device?.modelKey ?? 'device',
      accessory._associatedHAPAccessory.bridged ? '' : ' You will need to manually delete the device in the Home app to complete the removal.');

    const deletingAccessories = [accessory];

    // If it's an unknown device or a camera, look for a corresponding package camera if we have one and remove it as well.
     
    if(!device || (device?.modelKey === 'camera')) {

      const packageCameraAccessory = this.platform.accessories.find(x => accessoryContext(x).packageCamera === context.mac);

      // Remove the package camera, if it exists, and cleanup the device if it's been confgured.
      if(packageCameraAccessory) {

        deletingAccessories.push(packageCameraAccessory);
      }
    }

    // Cleanup our device instance.
    protectDevice?.cleanup();

    // Finally, remove it from our list of configured devices and HomeKit.
    delete this.configuredDevices[accessory.UUID];

    if(protectDevice && (this.devicesById.get(protectDevice.ufp.id) === protectDevice)) {

      this.devicesById.delete(protectDevice.ufp.id);
    }

    // Update our internal list of all the accessories we know about.
    for(const targetAccessory of deletingAccessories) {

      // Unregister the accessory from HomeKit if we have a bridged accessory. Unbridged accessories are managed directly by users in the Home app.
      if(targetAccessory._associatedHAPAccessory.bridged) {

        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [targetAccessory]);
      }

      this.platform.accessories.splice(this.platform.accessories.indexOf(targetAccessory), 1);
    }

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Return all configured devices.
  private get devicelist(): ProtectDevices[] {

    return Object.values(this.configuredDevices).filter(device => device !== undefined);
  }

  // Return all devices of a particular modelKey.
  private devices<T extends keyof ProtectDeviceTypes>(model?: T): ProtectDeviceTypes[T][] {

    return Object.values(this.configuredDevices).filter(device => device?.ufp.modelKey === model) as ProtectDeviceTypes[T][];
  }

  // Return the Protect device object based on it's unique device identifier, if it exists. This is called for every realtime event we receive, so we maintain
  // an index rather than searching our configured devices each time.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    return this.devicesById.get(deviceId) ?? null;
  }

  // Generate a snapshot of the accessory state Homebridge persists in its accessory cache that we're responsible for changing: names, context, and the
  // structure of services and characteristics. Characteristic values are deliberately excluded since they change constantly and are restored from Protect.
  private accessoryCacheState(): string {

    return JSON.stringify(this.platform.accessories.map(accessory => [ accessory.UUID, accessory.displayName, accessory.context,
      accessory.services.map(service => [ service.UUID, service.subtype ?? '', service.displayName, service.characteristics.map(x => x.UUID) ]) ]));
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: ProtectFeatureOptionKey): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: ProtectFeatureOptionKey): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
  }

  // Utility for checking the scope of feature options on the NVR.
  public isNvrFeature(option: ProtectFeatureOptionKey, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return [ 'global', 'controller' ].includes(this.platform.featureOptions.scope(option, device?.mac, this.ufp.mac));
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: ProtectFeatureOptionKey, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }

  // Utility for logging feature option availability on the NVR.
  public logFeature(option: ProtectFeatureOptionKey, message: string): void {

    // Feature option lookups are case-insensitive, so we track what we've logged by the normalized option name.
    const logKey = option.toLowerCase();

    // Only log something if we haven't already informed the user about it previously and it's scoped to the NVR or globally.
    if(this.featureLog[logKey] || !this.isNvrFeature(option)) {

      return;
    }

    this.featureLog[logKey] = true;

    this.log.info(message);
  }
}
