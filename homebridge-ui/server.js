/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * server.js: @mp-consulting/homebridge-unifi-protect webUI server API.
 */
'use strict';

import { featureOptionCategories, featureOptions } from '../dist/protect-options.js';
import { HomebridgePluginUiServer } from '../dist/lib/ui-server.js';
import { ProtectApi } from '../dist/unifi/index.js';
import { discoverOnvifEndpoints } from './onvif.js';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import util from 'node:util';

// Addresses the webUI server must never connect to on the user's behalf: loopback, link-local (which includes the 169.254.169.254 cloud metadata
// endpoint), and unspecified addresses. Private RFC1918 ranges are intentionally allowed - that is where controllers and cameras live.
const BLOCKED_ADDRESSES = new net.BlockList();

BLOCKED_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('::', 96, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6');

// Maximum snapshot payload we are willing to proxy back to the webUI. Enough for any 4K JPEG in practice.
export const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

// Check whether a single resolved IP address falls within a blocked range. Anything that isn't a well-formed IP is treated as blocked. IPv4-mapped IPv6
// addresses (::ffff:a.b.c.d, in any spelling) are unwrapped and checked against the IPv4 rules.
export function isBlockedIp(ip) {

  let address = String(ip ?? '').trim().replace(/%.*$/, '');
  let family = net.isIP(address);

  if(family === 6) {

    // Let the WHATWG URL parser canonicalize the IPv6 address so we only have one mapped-address spelling to recognize.
    const canonical = new URL('http://[' + address + ']').hostname;
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);

    if(mapped) {

      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);

      address = [ high >> 8, high & 0xFF, low >> 8, low & 0xFF ].join('.');
      family = 4;
    }
  }

  if(!family) {

    return true;
  }

  return BLOCKED_ADDRESSES.check(address, (family === 4) ? 'ipv4' : 'ipv6');
}

// Reduce a user-supplied address (bare host, host:port, IPv6 literal with or without brackets) to the hostname we would actually resolve. The WHATWG URL
// parser normalizes the alternate IPv4 spellings (0x7f.1, 2130706433, 017700000001) to dotted-quad for us. Returns null if the address is unusable.
export function canonicalHostname(address) {

  if(!address || (typeof address !== 'string')) {

    return null;
  }

  const trimmed = address.trim();

  if(!trimmed) {

    return null;
  }

  if(net.isIP(trimmed)) {

    return trimmed.toLowerCase();
  }

  try {

    const hostname = new URL('http://' + trimmed).hostname.replace(/^\[|\]$/g, '');

    return hostname || null;
  } catch {

    return null;
  }
}

// Resolve an address and vet every IP it maps to. Throws if the address is unusable, does not resolve, or any of its IPs is blocked - a name that
// resolves to both a LAN and a loopback address is rejected outright. Returns the first vetted address so callers can pin their connection to it and
// avoid a second, possibly different, resolution (DNS rebinding).
export async function resolveAllowedAddress(address, { isBlocked = isBlockedIp, lookup = dns.lookup } = {}) {

  const hostname = canonicalHostname(address);

  if(!hostname) {

    throw new Error('Invalid address.');
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });

  if(!Array.isArray(resolved) || !resolved.length) {

    throw new Error('Unable to resolve ' + hostname + '.');
  }

  if(resolved.some(entry => isBlocked(entry.address))) {

    throw new Error('Connections to ' + hostname + ' are not permitted.');
  }

  return { address: resolved[0].address, family: resolved[0].family, hostname };
}

// Boolean convenience wrapper around resolveAllowedAddress() for endpoints that simply refuse invalid addresses.
export async function isValidAddress(address, options = {}) {

  try {

    await resolveAllowedAddress(address, options);

    return true;
  } catch {

    return false;
  }
}

// Build a net.connect-compatible lookup function that always answers with an address we already vetted, so the actual connection can't be steered
// elsewhere by a second DNS answer.
function pinnedLookup(vetted) {

  return (_hostname, options, callback) => {

    if(options?.all) {

      callback(null, [{ address: vetted.address, family: vetted.family }]);

      return;
    }

    callback(null, vetted.address, vetted.family);
  };
}

// Fetch a camera snapshot on behalf of the webUI. Only http(s) URLs whose host resolves exclusively to permitted addresses are fetched, the connection is
// pinned to the vetted address, the response must be an image, and the body is capped at maxBytes. Credentials embedded in the URL are forwarded as HTTP
// Basic auth only when the URL's host matches expectedHost (the camera the user pointed ONVIF discovery at), when one is supplied. Resolves to
// { contentType, data } with base64 data, or rejects with a descriptive error.
export async function fetchSnapshot(url, { expectedHost, isBlocked, lookup, maxBytes = SNAPSHOT_MAX_BYTES, timeout = 15000 } = {}) {

  if(!url || (typeof url !== 'string')) {

    throw new Error('url is required.');
  }

  const parsed = new URL(url);

  if((parsed.protocol !== 'http:') && (parsed.protocol !== 'https:')) {

    throw new Error('Only http(s) snapshot URLs are supported.');
  }

  const vetted = await resolveAllowedAddress(parsed.host, { isBlocked, lookup });
  const headers = {};

  // Only hand the camera's credentials to the host the user actually asked us to talk to.
  if(parsed.username && (!expectedHost || (canonicalHostname(expectedHost) === vetted.hostname))) {

    const creds = decodeURIComponent(parsed.username) + ':' + decodeURIComponent(parsed.password || '');

    headers.Authorization = 'Basic ' + globalThis.Buffer.from(creds, 'utf8').toString('base64');
  }

  const lib = (parsed.protocol === 'https:') ? https : http;

  return new Promise((resolve, reject) => {

    const req = lib.request({

      headers,
      hostname: vetted.hostname,
      lookup: pinnedLookup(vetted),
      method: 'GET',
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      // Cameras almost universally present self-signed certificates, so we can't validate them here.
      rejectUnauthorized: false,
      // 15s rather than 5s: high-res Tapo snapshots can take several seconds to stream over the local network, especially when the camera is busy.
      timeout,
    }, (res) => {

      if(res.statusCode !== 200) {

        res.resume();
        reject(new Error('HTTP ' + res.statusCode + (res.headers['www-authenticate'] ? ' (' + res.headers['www-authenticate'] + ')' : '')));

        return;
      }

      const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

      if(!contentType.startsWith('image/')) {

        res.destroy();
        reject(new Error('Snapshot URL did not return an image (content-type: ' + (contentType || 'none') + ').'));

        return;
      }

      const tooLarge = () => {

        res.destroy();
        reject(new Error('Snapshot payload exceeded ' + Math.round(maxBytes / (1024 * 1024)) + ' MB and was aborted.'));
      };

      if(Number(res.headers['content-length']) > maxBytes) {

        tooLarge();

        return;
      }

      const chunks = [];
      let totalLength = 0;

      res.on('data', (chunk) => {

        totalLength += chunk.length;

        // Abort the response rather than letting it finish then rejecting, so we don't waste bandwidth pulling down an oversized payload.
        if(totalLength > maxBytes) {

          tooLarge();

          return;
        }

        chunks.push(chunk);
      });
      res.on('end', () => resolve({ contentType, data: globalThis.Buffer.concat(chunks).toString('base64') }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Snapshot fetch timed out.')));
    req.end();
  });
}

// Number of adjacent /24 subnets to scan in each direction from each local interface.
// A value of 5 means scanning ±5 subnets (up to 2,540 unicast probes per local subnet).
// Only used for discovering UniFi devices on routed subnets where broadcasts don't reach.
const ADJACENT_SUBNET_RANGE = 5;
const DISCOVERY_TIMEOUT = 5000;
const UBNT_DISCOVERY_PORT = 10001;

// Maximum time to wait for the controller to respond when validating credentials from the webUI. The unifi-protect client retries internally for ~2
// minutes before giving up, which is far too long for the "Save Controller" interaction in the webUI - users see "Validating..." forever and assume the
// page is broken. 20 seconds is long enough for a healthy controller to respond and short enough to fail visibly when something is wrong.
const GET_DEVICES_TIMEOUT_MS = 20000;

// Ubiquiti L2 Discovery Protocol: send a 4-byte packet, devices respond with TLV data.
const UBNT_DISCOVERY_PACKET = globalThis.Buffer.from([ 0x01, 0x00, 0x00, 0x00 ]);

// TLV field types in the Ubiquiti discovery response.
const UBNT_TLV = {

  FIRMWARE: 0x03,     // Firmware version string
  HOSTNAME: 0x0B,     // Device hostname
  MAC_IP: 0x02,       // 6-byte MAC + 4-byte IP
  MODEL_LONG: 0x14,   // Full model name
  MODEL_SHORT: 0x0C,   // Short model name (e.g. "UNVR")
};

// Maximum number of per-request error messages we hold on to for /getErrorMessage before discarding the oldest.
const MAX_STORED_ERRORS = 20;

export class PluginUiServer extends HomebridgePluginUiServer {

  // Error messages from /getDevices, keyed by the caller-supplied requestId so concurrent validations can't overwrite each other's errors.
  #errors = new Map();

  // The most recent /getDevices error, kept for callers that don't supply a requestId.
  #lastError = '';

  constructor() {

    super();

    // Register getErrorMessage() with the Homebridge server API.
    this.#registerGetErrorMessage();

    // Register getDevices() with the Homebridge server API.
    this.#registerGetDevices();

    // Register getOptions() with the Homebridge server API.
    this.#registerGetOptions();

    // Register discover() with the Homebridge server API.
    this.#registerDiscover();

    // Register checkStatus() with the Homebridge server API.
    this.#registerCheckStatus();

    // Register discoverOnvif() with the Homebridge server API.
    this.#registerDiscoverOnvif();

    // Register fetchSnapshot() with the Homebridge server API.
    this.#registerFetchSnapshot();

    this.ready();
  }

  // Register the discoverOnvif() webUI server API endpoint. Used by the third-party camera URL override panel to auto-populate the RTSP and snapshot
  // URLs from a camera's IP and credentials, mirroring UniFi Protect's own Advanced Adoption flow.
  #registerDiscoverOnvif() {

    this.onRequest('/discoverOnvif', async (payload) => {

      try {

        const result = await discoverOnvifEndpoints({

          host: payload?.host?.trim(),
          password: payload?.password ?? '',
          port: payload?.port ? Number(payload.port) : undefined,
          servicePath: payload?.servicePath?.trim(),
          username: payload?.username?.trim(),
        });

        return { ok: true, ...result };
      } catch(err) {

        return { error: err instanceof Error ? err.message : String(err), ok: false };
      }
    });
  }

  // Register the fetchSnapshot() webUI server API endpoint. Acts as a CORS-bypassing proxy so the third-party camera URL override panel can render
  // a small preview thumbnail for each ONVIF profile next to the picker. Cameras typically gate their snapshot endpoint behind HTTP Basic auth, so we
  // pull credentials out of the URL (where ONVIF discovery embedded them) and forward them in an Authorization header. Digest-auth-only cameras will
  // return 401 here - the picker treats that as "no thumbnail available" and the user can still pick by name/resolution.
  #registerFetchSnapshot() {

    this.onRequest('/fetchSnapshot', async (payload) => {

      try {

        const result = await fetchSnapshot(payload?.url, { expectedHost: (typeof payload?.host === 'string') ? payload.host : undefined });

        return { contentType: result.contentType, data: result.data, ok: true };
      } catch(err) {

        return { error: err instanceof Error ? err.message : String(err), ok: false };
      }
    });
  }

  // Record the error message produced by a /getDevices request so the webUI can retrieve it with /getErrorMessage.
  #recordError(requestId, message) {

    this.#lastError = message;

    if((typeof requestId !== 'string') || !requestId) {

      return;
    }

    this.#errors.delete(requestId);
    this.#errors.set(requestId, message);

    // Maps iterate in insertion order, so the first key is always the oldest entry.
    while(this.#errors.size > MAX_STORED_ERRORS) {

      this.#errors.delete(this.#errors.keys().next().value);
    }
  }

  // Register the getErrorMessage() webUI server API endpoint.
  #registerGetErrorMessage() {

    // Return the error message generated by the /getDevices request identified by requestId, or the most recent one if no requestId is supplied.
    this.onRequest('/getErrorMessage', (payload) => {

      const requestId = payload?.requestId;

      if((typeof requestId !== 'string') || !requestId) {

        return this.#lastError;
      }

      const message = this.#errors.get(requestId) ?? '';

      this.#errors.delete(requestId);

      return message;
    });
  }

  // Register the getDevices() webUI server API endpoint.
  #registerGetDevices() {

    // Return the list of Protect devices.
    this.onRequest('/getDevices', async (controller) => {

      // Everything below is request-local so concurrent validations from the webUI can't clobber each other's API session or error message.
      let errorInfo = '';
      let ufpApi;

      // Validate the controller address before attempting a connection.
      try {

        await resolveAllowedAddress(controller?.address);
      } catch(err) {

        this.#recordError(controller?.requestId, err instanceof Error ? err.message : String(err));

        return [];
      }

      try {

        const log = {

          debug: () => {},
          error: (message, parameters = []) => {

            // Save the error to inform the user in the webUI.
            errorInfo = util.format(message, ...(Array.isArray(parameters) ? parameters : [parameters]));


            console.error(errorInfo);
          },
          info: () => {},
          warn: () => {},
        };

        // Connect to the Protect controller, honoring the controller's TLS validation preference.
        ufpApi = new ProtectApi(log, { verifyTls: controller.verifyTls === true });

        // Race the login + bootstrap against a timeout so the webUI fails visibly instead of hanging on "Validating..." for the full ~2-minute internal
        // unifi-protect retry budget when the controller is unreachable or slow.
        const ready = (async () => {

          if(!(await ufpApi.login(controller.address, controller.username, controller.password))) {

            return false;
          }

          return Boolean(await ufpApi.getBootstrap());
        })();

        let timeoutHandle;
        const timeout = new Promise((resolve) => {

          timeoutHandle = globalThis.setTimeout(() => resolve('timeout'), GET_DEVICES_TIMEOUT_MS);
        });

        const outcome = await Promise.race([ ready, timeout ]);

        globalThis.clearTimeout(timeoutHandle);

        if(outcome === 'timeout') {

          errorInfo = 'Timed out after ' + (GET_DEVICES_TIMEOUT_MS / 1000) + 's waiting for ' + controller.address +
            ' to respond. Check that the address and credentials are correct and that the controller is reachable from this Homebridge host.';

          return [];
        }

        if(!outcome) {

          return [];
        }

        const bootstrap = ufpApi.bootstrap;

        bootstrap.cameras = bootstrap.cameras.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.chimes = bootstrap.chimes.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.lights = bootstrap.lights.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.sensors = bootstrap.sensors.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.viewers = bootstrap.viewers.filter(x => !x.isAdoptedByOther && x.isAdopted);

        bootstrap.cameras.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.chimes.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.lights.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.sensors.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.viewers.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        return [ ufpApi.bootstrap.nvr, ...ufpApi.bootstrap.cameras, ...ufpApi.bootstrap.chimes, ...ufpApi.bootstrap.lights, ...ufpApi.bootstrap.sensors,
          ...ufpApi.bootstrap.viewers ];
      } catch(err) {


        console.log(err);

        // Return nothing if we error out for some reason.
        return [];
      } finally {

        ufpApi?.logout();
        this.#recordError(controller?.requestId, errorInfo);
      }
    });
  }

  // Register the getOptions() webUI server API endpoint.
  #registerGetOptions() {

    // Return the list of options configured for a given Protect device.
    this.onRequest('/getOptions', () => ({ categories: featureOptionCategories, options: featureOptions }));
  }

  // Register the discover() webUI server API endpoint using the Ubiquiti L2 Discovery Protocol.
  #registerDiscover() {

    this.onRequest('/discover', () => {

      return new Promise((resolve) => {

        const devices = [];
        const seen = new Set();

        const socket = dgram.createSocket({ reuseAddr: true, type: 'udp4' });

        socket.on('message', (msg) => {

          // Parse the Ubiquiti discovery response (TLV format after 4-byte header).
          if(msg.length < 4) {
            return;
          }

          const device = {};
          let offset = 4;

          while(offset + 3 <= msg.length) {

            const type = msg[offset];
            const length = msg.readUInt16BE(offset + 1);

            offset += 3;

            if(offset + length > msg.length) {
              break;
            }

            const value = msg.subarray(offset, offset + length);

            switch(type) {

              case UBNT_TLV.MAC_IP:

                if(length >= 10) {

                  device.mac = [...value.subarray(0, 6)].map(b => b.toString(16).padStart(2, '0')).join(':');
                  device.ip = value[6] + '.' + value[7] + '.' + value[8] + '.' + value[9];
                }

                break;

              case UBNT_TLV.HOSTNAME:

                device.hostname = value.toString('utf8');

                break;

              case UBNT_TLV.MODEL_SHORT:

                device.model = value.toString('utf8');

                break;

              case UBNT_TLV.MODEL_LONG:

                device.modelLong = value.toString('utf8');

                break;

              case UBNT_TLV.FIRMWARE:

                device.firmware = value.toString('utf8');

                break;

              default:

                break;
            }

            offset += length;
          }

          if(device.ip && !seen.has(device.ip)) {

            seen.add(device.ip);

            devices.push({

              firmware: device.firmware || '',
              ip: device.ip,
              mac: device.mac || '',
              model: device.model || '',
              modelLong: device.modelLong || '',
              name: device.hostname || device.model || device.ip,
            });
          }
        });

        socket.on('error', () => {

          try {
            socket.close();
          } catch{ /* ignore */ }
          resolve([]);
        });

        socket.bind(() => {

          socket.setBroadcast(true);

          // Broadcast to all local subnet broadcast addresses to reach devices on directly-connected subnets.
          const broadcastAddresses = new Set(['255.255.255.255']);
          const localSubnets = [];

          for(const iface of Object.values(os.networkInterfaces())) {

            for(const info of (iface || [])) {

              if((info.family === 'IPv4') && !info.internal) {

                const ipParts = info.address.split('.').map(Number);
                const maskParts = info.netmask.split('.').map(Number);
                const broadcast = ipParts.map((ip, i) => (ip | (~maskParts[i] & 0xFF))).join('.');

                broadcastAddresses.add(broadcast);

                // Track /24+ subnets for adjacent unicast scanning.
                if(maskParts[2] === 255) {

                  localSubnets.push([ ipParts[0], ipParts[1], ipParts[2] ]);
                }
              }
            }
          }

          for(const addr of broadcastAddresses) {

            socket.send(UBNT_DISCOVERY_PACKET, 0, UBNT_DISCOVERY_PACKET.length, UBNT_DISCOVERY_PORT, addr);
          }

          // Unicast scan adjacent /24 subnets to find devices across routed subnets (broadcasts don't cross routers).
          const scannedSubnets = new Set(localSubnets.map(s => s.join('.')));

          for(const [ a, b, c ] of localSubnets) {

            for(let offset = -ADJACENT_SUBNET_RANGE; offset <= ADJACENT_SUBNET_RANGE; offset++) {

              const adjacentC = c + offset;

              if((adjacentC < 0) || (adjacentC > 255)) {

                continue;
              }

              const subnetKey = a + '.' + b + '.' + adjacentC;

              if(scannedSubnets.has(subnetKey)) {

                continue;
              }

              scannedSubnets.add(subnetKey);

              for(let host = 1; host <= 254; host++) {

                socket.send(UBNT_DISCOVERY_PACKET, 0, UBNT_DISCOVERY_PACKET.length, UBNT_DISCOVERY_PORT, a + '.' + b + '.' + adjacentC + '.' + host);
              }
            }
          }
        });

        // Stop after timeout and return results.
        globalThis.setTimeout(() => {

          try {
            socket.close();
          } catch{ /* ignore */ }
          resolve(devices);
        }, DISCOVERY_TIMEOUT);
      });
    });
  }

  // Register the checkStatus() webUI server API endpoint.
  #registerCheckStatus() {

    this.onRequest('/checkStatus', async (payload) => {

      let vetted;

      try {

        vetted = await resolveAllowedAddress(payload?.address);
      } catch {

        return { online: false };
      }

      return new Promise((resolve) => {

        const req = https.request({

          hostname: vetted.hostname,
          lookup: pinnedLookup(vetted),
          method: 'HEAD',
          path: '/',
          port: 443,
          rejectUnauthorized: false,
          timeout: 5000,
        }, () => resolve({ online: true }));

        req.on('error', () => resolve({ online: false }));
        req.on('timeout', () => {

          req.destroy();
          resolve({ online: false });
        });

        req.end();
      });
    });
  }
}

// Only start the server when this file is the process entry point - the Homebridge UI forks it directly - so tests can import the helpers above without
// spinning up an IPC server. We compare real paths because the plugin is frequently installed through a symlink (npm link, pnpm).
const isEntryPoint = (() => {

  try {

    return (typeof process.argv[1] === 'string') && (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {

    return false;
  }
})();

if(isEntryPoint) {

  new PluginUiServer();
}
