/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * util.ts: Utility types and functions for the plugin, dependency-free.
 */

// Recursive partial variant of a type, making every property (and nested property) optional.
export type DeepPartial<T> = {

  [P in keyof T]?: T[P] extends Array<infer I> ? Array<DeepPartial<I>> : DeepPartial<T[P]>;
};

// Convenience shorthand for a nullable type.
export type Nullable<T> = T | null;

// Utility type that makes all properties of a type optional except the ones specified, which are required.
export type PartialWithId<T, K extends keyof T> = Partial<T> & Pick<T, K>;

// Logging interface used throughout the plugin so we can accept both Homebridge and custom loggers.
export interface HomebridgePluginLogging {

  debug: (message: string, ...parameters: unknown[]) => void;
  error: (message: string, ...parameters: unknown[]) => void;
  info: (message: string, ...parameters: unknown[]) => void;
  warn: (message: string, ...parameters: unknown[]) => void;
}

// Validates a name against HomeKit's naming conventions. Compiled once at module scope since this sits on the fast path of sanitizeName().
const VALID_HOMEKIT_NAME = /^(?!.*\p{Extended_Pictographic})(?!.* {2})(?=^[\p{L}\p{N}].*[\p{L}\p{N}.]$)[\p{L}\p{N}\-"'.,#& ]+$/u;

// A utility method that formats a bitrate value into a human-readable form as bps, kbps, or Mbps.
export function formatBps(value: number): string {

  // Return the bitrate as-is.
  if(value < 1000) {

    return value.toString() + ' bps';
  }

  // Return the bitrate in kilobits.
  if(value < 1000000) {

    const kbps = value / 1000;

    return ((kbps % 1) === 0 ? kbps.toFixed(0) : kbps.toFixed(1)) + ' kbps';
  }

  // Return the bitrate in megabits.
  const mbps = value / 1000000;

  return ((mbps % 1) === 0 ? mbps.toFixed(0) : mbps.toFixed(1)) + ' Mbps';
}

// Retry an asynchronous operation at a given interval, optionally up to a total number of retries. The operation must resolve to true when successful.
export async function retry(operation: () => Promise<boolean>, retryInterval: number, totalRetries?: number): Promise<boolean> {

  let remainingRetries = totalRetries;

  for(;;) {

    // If we've exhausted our retries, we're done.
    if((remainingRetries !== undefined) && (remainingRetries <= 0)) {

      return false;
    }

    // Try the operation that was requested.
     
    if(await operation()) {

      return true;
    }

    // If the operation wasn't successful, sleep for the requested interval and try again.
    if(remainingRetries !== undefined) {

      remainingRetries--;
    }

     
    await sleep(retryInterval);
  }
}

// Run a promise with a guaranteed timeout to complete, resolving to null if the timeout expires first. The underlying promise is not cancelled.
export async function runWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<Nullable<T>> {

  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeout); 
  });

  return Promise.race([ promise, timeoutPromise ]).finally(() => clearTimeout(timer));
}

// Emulate a sleep function.
export async function sleep(sleepTimer: number): Promise<void> {

  return new Promise(resolve => setTimeout(resolve, sleepTimer));
}

// Start case a string, capitalizing the first letter of each word unconditionally.
export function toStartCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

// Sanitize an accessory name according to HomeKit naming conventions, replacing invalid characters with a space and squashing multiple spaces.
export function sanitizeName(name: string): string {

  // Fast path: if the name already conforms to HomeKit's naming rules, skip the replacement chain entirely.
  if(validateName(name)) {

    return name;
  }

  // Here are the steps we're taking to sanitize names for HomeKit:
  //
  //   - Replace any disallowed char (including emojis) with a space.
  //   - Collapse multiple spaces to one.
  //   - Trim spaces at the beginning and end of the string.
  //   - Strip any leading non-letter/number.
  //   - Collapse two or more trailing periods into one.
  //   - Remove any other trailing char that's not letter/number/period.
  return name.replace(/[^\p{L}\p{N}\-"'.,#&\s]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/\.{2,}$/g, '.')
    .replace(/[^\p{L}\p{N}.]$/u, '');
}

// Validate an accessory name according to HomeKit naming conventions.
export function validateName(name: string): boolean {

  return VALID_HOMEKIT_NAME.test(name);
}
