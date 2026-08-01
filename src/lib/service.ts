/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * service.ts: Useful Homebridge service support functions.
 */
import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { Nullable } from './util.js';
import { sanitizeName } from './util.js';

// Cached Sets for O(1) service UUID lookups. Lazily initialized on first use.
let requiresConfiguredNameUUIDs: Nullable<Set<string>> = null;
let hasConfiguredNameUUIDs: Nullable<Set<string>> = null;
let requiresNameUUIDs: Nullable<Set<string>> = null;
let hasNameUUIDs: Nullable<Set<string>> = null;

// Retrieves the Characteristic constructor from a service instance. Homebridge's HAP types don't expose a direct way to access the Characteristic constructor
// from a service without holding a reference to the HAP object itself. This reflection pattern extracts it from the first characteristic on any service
// instance,
// which always exists (every service has at least one required characteristic). Centralized here so the fragile cast lives in one place.
function getCharacteristicConstructor(service: Service): typeof Characteristic {

  return service.characteristics[0].constructor as unknown as typeof Characteristic;
}

// Initializes the cached UUID Sets for service characteristic lookups.
function initServiceUUIDSets(service: Service): void {

  // Already initialized.
  if(requiresConfiguredNameUUIDs) {

    return;
  }

  // Grab the constructor from the instance of our service so we can access the static UUID properties.
  const ctor = service.constructor as unknown as typeof Service;

  // Services that require the ConfiguredName characteristic.
  requiresConfiguredNameUUIDs = new Set([
    ctor.InputSource.UUID, ctor.Television.UUID, ctor.WiFiRouter.UUID,
  ]);

  // Services that support the ConfiguredName characteristic (includes required).
  hasConfiguredNameUUIDs = new Set([
    ctor.AccessoryInformation.UUID, ctor.ContactSensor.UUID, ctor.InputSource.UUID, ctor.Lightbulb.UUID, ctor.MotionSensor.UUID,
    ctor.OccupancySensor.UUID, ctor.SmartSpeaker.UUID, ctor.Switch.UUID, ctor.Television.UUID, ctor.Valve.UUID, ctor.WiFiRouter.UUID,
  ]);

  // Services that require the Name characteristic.
  requiresNameUUIDs = new Set([
    ctor.AccessoryInformation.UUID, ctor.Assistant.UUID, ctor.InputSource.UUID,
  ]);

  // Services that support the Name characteristic (includes required).
  hasNameUUIDs = new Set([
    ctor.AccessoryInformation.UUID, ctor.AirPurifier.UUID, ctor.AirQualitySensor.UUID, ctor.Assistant.UUID, ctor.Battery.UUID,
    ctor.CarbonDioxideSensor.UUID, ctor.CarbonMonoxideSensor.UUID, ctor.ContactSensor.UUID, ctor.Door.UUID, ctor.Doorbell.UUID,
    ctor.Fan.UUID, ctor.Fanv2.UUID, ctor.Faucet.UUID, ctor.FilterMaintenance.UUID, ctor.GarageDoorOpener.UUID, ctor.HeaterCooler.UUID,
    ctor.HumidifierDehumidifier.UUID, ctor.HumiditySensor.UUID, ctor.InputSource.UUID, ctor.IrrigationSystem.UUID, ctor.LeakSensor.UUID,
    ctor.Lightbulb.UUID, ctor.LightSensor.UUID, ctor.LockMechanism.UUID, ctor.MotionSensor.UUID, ctor.OccupancySensor.UUID, ctor.Outlet.UUID,
    ctor.SecuritySystem.UUID, ctor.Slats.UUID, ctor.SmartSpeaker.UUID, ctor.SmokeSensor.UUID, ctor.StatefulProgrammableSwitch.UUID,
    ctor.StatelessProgrammableSwitch.UUID, ctor.Switch.UUID, ctor.TargetControl.UUID, ctor.Television.UUID, ctor.TemperatureSensor.UUID,
    ctor.Thermostat.UUID, ctor.Valve.UUID, ctor.Window.UUID, ctor.WindowCovering.UUID,
  ]);
}

// Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a
// new service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.
export function acquireService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, name: string, subtype?: string,
  onServiceCreate?: (svc: Service) => void): Nullable<Service> {

  // Ensure we have HomeKit approved naming.
  name = sanitizeName(name);

  // Find the service, if it exists.
  let service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Add the service to the accessory, if needed.
  if(!service) {

    // WithUUID<typeof Service> types subtype as required, but the constructor handles undefined at runtime.
    service = new serviceType(name, subtype as string);

    // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object
    // directly.
    const characteristic = getCharacteristicConstructor(service);

    // Add the Configured Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresConfiguredName(service) && serviceHasConfiguredName(service) &&
      !service.optionalCharacteristics.some(x => (x.UUID === characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(characteristic.ConfiguredName);
    }

    // Add the Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresName(service) && serviceHasName(service) && !service.optionalCharacteristics.some(x => (x.UUID === characteristic.Name.UUID))) {

      service.addOptionalCharacteristic(characteristic.Name);
    }

    // Set our name.
    setServiceName(service, name);

    accessory.addService(service);

    if(onServiceCreate) {

      onServiceCreate(service);
    }
  }

  return service;
}

// Validates whether a specific service should exist on the given accessory, removing the service if it fails validation. The validate parameter can either be a
// boolean or a function receiving whether the service currently exists and returning whether to keep it.
export function validService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, validate: boolean | ((hasService: boolean) => boolean),
  subtype?: string): boolean {

  // Find the service, if it exists.
  const service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Validate whether we should have the service. If not, remove it.
  if(!((typeof validate === 'function') ? validate(!!service) : validate)) {

    if(service) {

      accessory.removeService(service);
    }

    return false;
  }

  // We have a valid service.
  return true;
}

// Determines whether the specified service type requires the ConfiguredName characteristic.
function serviceRequiresConfiguredName(service: Service): boolean {

  initServiceUUIDSets(service);

  return requiresConfiguredNameUUIDs?.has(service.UUID) ?? false;
}

// Determines whether the specified service type supports the ConfiguredName characteristic.
function serviceHasConfiguredName(service: Service): boolean {

  initServiceUUIDSets(service);

  return hasConfiguredNameUUIDs?.has(service.UUID) ?? false;
}

// Determines whether the specified service type requires the Name characteristic.
function serviceRequiresName(service: Service): boolean {

  initServiceUUIDSets(service);

  return requiresNameUUIDs?.has(service.UUID) ?? false;
}

// Determines whether the specified service type supports the Name characteristic.
function serviceHasName(service: Service): boolean {

  initServiceUUIDSets(service);

  return hasNameUUIDs?.has(service.UUID) ?? false;
}

// Retrieves the primary name of a service, preferring the ConfiguredName characteristic over the Name characteristic.
export function getServiceName(service?: Service): string | undefined {

  // No service, we're done.
  if(!service) {

    return undefined;
  }

  // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object directly.
  const characteristic = getCharacteristicConstructor(service);

  return (service.getCharacteristic(characteristic.ConfiguredName).value ?? service.getCharacteristic(characteristic.Name).value ?? undefined) as
    string | undefined;
}

// Updates the displayName and applicable name characteristics of a service to the specified value.
export function setServiceName(service: Service, name: string): void {

  // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object directly.
  const characteristic = getCharacteristicConstructor(service);

  // Ensure we have HomeKit approved naming.
  name = sanitizeName(name);

  // Update our name.
  service.displayName = name;

  if(serviceHasConfiguredName(service)) {

    service.updateCharacteristic(characteristic.ConfiguredName, name);
  }

  if(serviceHasName(service)) {

    service.updateCharacteristic(characteristic.Name, name);
  }
}
