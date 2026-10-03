/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-accessory-context.ts: Typed view of the persistent context we store on Homebridge accessories.
 */
import type { PlatformAccessory } from 'homebridge';

// The known keys we persist in a Homebridge accessory context. Homebridge types the context as Record<string, any>, so this is the single place where we
// document what HBUP stores there and what type each entry holds.
export interface ProtectAccessoryContext {

  // Whether motion detection is enabled for this device (cameras, lights, sensors).
  detectMotion?: boolean;

  // Whether doorbell ring notifications are muted in HomeKit.
  doorbellMuted?: boolean;

  // Legacy HKSV recording state from older releases. Only read for migration purposes.
  hksvRecording?: boolean;

  // Whether HKSV event recording has been disabled through the HKSV recording switch.
  hksvRecordingDisabled?: boolean;

  // The liveview name associated with a liveview switch accessory.
  liveview?: string;

  // The last known state of a liveview switch accessory.
  liveviewState?: boolean;

  // The MAC address of the Protect device this accessory represents. Synthetic accessories (e.g. package cameras) intentionally omit this.
  mac?: string;

  // The MAC address of the Protect controller this accessory is associated with.
  nvr?: string;

  // The MAC address of the parent device of a package camera accessory.
  packageCamera?: string;

  // The current state of the security system accessory.
  securityState?: number;

  // Whether this accessory is the controller system information accessory.
  systemInfo?: boolean;
}

// Return a typed view of an accessory context.
export function accessoryContext(accessory: PlatformAccessory): ProtectAccessoryContext {

  return accessory.context;
}
