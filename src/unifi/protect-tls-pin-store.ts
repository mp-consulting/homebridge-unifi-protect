/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-tls-pin-store.ts: Persistent storage for trust-on-first-use TLS certificate pins, keyed by controller address.
 */
import fs from 'node:fs';
import { normalizeFingerprint } from './protect-api-tls.js';

/**
 * A small JSON file mapping Protect controller addresses to the SHA-256 fingerprints of the TLS certificates we've pinned for them. The API client itself is
 * storage-agnostic - this store is what the plugin wires into it.
 *
 * @internal
 */
export class ProtectTlsPinStore {

  public readonly filename: string;
  private readonly onError: (message: string) => void;
  private pins: Record<string, string> | undefined;

  /**
   * @param filename - Full path to the JSON file used to persist pins.
   * @param onError  - Called with a description of any problem reading or writing the file.
   */
  constructor(filename: string, onError: (message: string) => void = (): void => {}) {

    this.filename = filename;
    this.onError = onError;
    this.pins = undefined;
  }

  // Retrieve the pinned fingerprint for a controller address, if we have one.
  public get(address: string): string | undefined {

    return this.load()[this.key(address)];
  }

  // Pin a fingerprint for a controller address and persist it.
  public set(address: string, fingerprint: string): void {

    const normalized = normalizeFingerprint(fingerprint);

    if(!normalized) {

      return;
    }

    const pins = this.load();

    pins[this.key(address)] = normalized;

    // Write atomically so a crash mid-write can't leave us with a truncated file, and keep the file private to the Homebridge user.
    const tmpFile = this.filename + '.tmp';

    try {

      fs.writeFileSync(tmpFile, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmpFile, this.filename);
    } catch(error) {

      this.onError('Unable to save the pinned TLS certificate fingerprint to ' + this.filename + ': ' + String(error) + '.');
    }
  }

  // Normalize controller addresses so trivially different spellings share a pin.
  private key(address: string): string {

    return address.trim().toLowerCase();
  }

  // Load our pins from disk, once.
  private load(): Record<string, string> {

    if(this.pins) {

      return this.pins;
    }

    this.pins = {};

    let contents: string;

    try {

      contents = fs.readFileSync(this.filename, 'utf8');
    } catch(error) {

      // A missing file simply means we haven't pinned anything yet.
      if((error as NodeJS.ErrnoException).code !== 'ENOENT') {

        this.onError('Unable to read pinned TLS certificate fingerprints from ' + this.filename + ': ' + String(error) + '.');
      }

      return this.pins;
    }

    try {

      const parsed = JSON.parse(contents) as unknown;

      if(parsed && (typeof parsed === 'object') && !Array.isArray(parsed)) {

        for(const [ address, fingerprint ] of Object.entries(parsed)) {

          const normalized = (typeof fingerprint === 'string') ? normalizeFingerprint(fingerprint) : undefined;

          if(normalized) {

            this.pins[this.key(address)] = normalized;
          }
        }
      }
    } catch(error) {

      this.onError('Unable to parse pinned TLS certificate fingerprints in ' + this.filename + ': ' + String(error) + '.');
    }

    return this.pins;
  }
}
