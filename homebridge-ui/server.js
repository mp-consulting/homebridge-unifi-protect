/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * server.js: @mp-consulting/homebridge-unifi-protect webUI server API.
 */
'use strict';

import { featureOptionCategories, featureOptions } from '../dist/protect-options.js';
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { ProtectApi } from 'unifi-protect';
import { discoverOnvifEndpoints } from './onvif.js';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import util from 'node:util';

// Validate a controller address, rejecting loopback, link-local, and unspecified addresses.
function isValidAddress(address) {

  if(!address || (typeof address !== 'string')) {

    return false;
  }

  const trimmed = address.trim().toLowerCase();

  if(!trimmed || (trimmed === 'localhost') || trimmed.startsWith('127.') || trimmed.startsWith('169.254.') || (trimmed === '0.0.0.0') ||
    trimmed.startsWith('[') || trimmed.includes('::')) {

    return false;
  }

  return true;
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

class PluginUiServer extends HomebridgePluginUiServer {

  errorInfo;

  constructor() {

    super();

    this.errorInfo = '';

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

      const url = payload?.url;

      if(!url || (typeof url !== 'string')) {

        return { error: 'url is required.', ok: false };
      }

      try {

        const result = await new Promise((resolve, reject) => {

          let parsed;

          try {

            parsed = new URL(url);
          } catch(err) {

            reject(err);

            return;
          }

          if((parsed.protocol !== 'http:') && (parsed.protocol !== 'https:')) {

            reject(new Error('Only http(s) snapshot URLs are supported.'));

            return;
          }

          const lib = (parsed.protocol === 'https:') ? https : http;
          const headers = {};

          if(parsed.username) {

            const creds = decodeURIComponent(parsed.username) + ':' + decodeURIComponent(parsed.password || '');

            headers.Authorization = 'Basic ' + globalThis.Buffer.from(creds, 'utf8').toString('base64');
          }

          const req = lib.request({

            headers,
            hostname: parsed.hostname,
            method: 'GET',
            path: parsed.pathname + parsed.search,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            rejectUnauthorized: false,
            // 15s rather than 5s: high-res Tapo snapshots can take several seconds to stream over the local network, especially when the camera is busy.
            timeout: 15000,
          }, (res) => {

            if(res.statusCode !== 200) {

              res.resume();
              reject(new Error('HTTP ' + res.statusCode + (res.headers['www-authenticate'] ? ' (' + res.headers['www-authenticate'] + ')' : '')));

              return;
            }

            const chunks = [];
            let totalLength = 0;

            res.on('data', (chunk) => {

              totalLength += chunk.length;

              // Cap streaming at ~4 MB. We abort the response (rather than letting it finish then rejecting) so we don't waste bandwidth pulling down
              // a multi-megabyte original snapshot just to throw it away. 4 MB is enough for any 4K JPEG in practice.
              if(totalLength > 4 * 1024 * 1024) {

                res.destroy();
                reject(new Error('Snapshot payload exceeded 4 MB and was aborted.'));

                return;
              }

              chunks.push(chunk);
            });
            res.on('end', () => {

              const buffer = globalThis.Buffer.concat(chunks);

              resolve({

                contentType: res.headers['content-type'] || 'image/jpeg',
                data: buffer.toString('base64'),
              });
            });
            res.on('error', reject);
          });

          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('Snapshot fetch timed out.')));
          req.end();
        });

        return { contentType: result.contentType, data: result.data, ok: true };
      } catch(err) {

        return { error: err instanceof Error ? err.message : String(err), ok: false };
      }
    });
  }

  // Register the getErrorMessage() webUI server API endpoint.
  #registerGetErrorMessage() {

    // Return the most recent error message generated by the Protect API.
    this.onRequest('/getErrorMessage', () => this.errorInfo);
  }

  // Register the getDevices() webUI server API endpoint.
  #registerGetDevices() {

    let ufpApi;

    // Return the list of Protect devices.
    this.onRequest('/getDevices', async (controller) => {

      // Validate the controller address before attempting a connection.
      if(!isValidAddress(controller.address)) {

        return [];
      }

      try {

        const log = {

          debug: () => {},
          error: (message, parameters = []) => {

            // Save the error to inform the user in the webUI.
            this.errorInfo = util.format(message, ...(Array.isArray(parameters) ? parameters : [parameters]));


            console.error(this.errorInfo);
          },
          info: () => {},
          warn: () => {},
        };

        // Connect to the Protect controller.
        ufpApi = new ProtectApi(log);

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

          this.errorInfo = 'Timed out after ' + (GET_DEVICES_TIMEOUT_MS / 1000) + 's waiting for ' + controller.address +
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

    this.onRequest('/checkStatus', (payload) => {

      return new Promise((resolve) => {

        if(!isValidAddress(payload?.address)) {

          resolve({ online: false });

          return;
        }

        const req = https.request({

          hostname: payload.address,
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

(() => new PluginUiServer())();
