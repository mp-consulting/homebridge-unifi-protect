/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * onvif.js: Minimal ONVIF SOAP client used by the Homebridge custom UI to discover the live RTSP and snapshot URLs of an adopted third-party camera
 * given its IP, port, and credentials. Only implements GetCapabilities, GetProfiles, GetStreamUri, and GetSnapshotUri - just enough to populate the
 * cameraOverrides config block automatically. WS-UsernameToken (PasswordDigest) is hand-rolled to avoid pulling a heavy ONVIF dependency.
 */
'use strict';

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Common ONVIF service ports tried in order when the user does not specify one or when the configured port refuses the connection. 80 is the spec
// default; 8000/8080/2020/8899 cover the bulk of consumer cameras (Tapo uses 2020, some Hikvision/Dahua use 8000/8080, Reolink uses 8000).
const DEFAULT_ONVIF_PORTS = [ 80, 8000, 8080, 2020, 8899 ];

const DEFAULT_SERVICE_PATH = '/onvif/device_service';

const SOAP_TIMEOUT_MS = 5000;

// ONVIF SOAP responses are a few kilobytes in practice. Anything beyond this is not a well-behaved camera and we stop reading rather than buffer it.
export const SOAP_MAX_BYTES = 1024 * 1024;

// Build a WS-Security UsernameToken header with PasswordDigest authentication. The digest is Base64(SHA1(nonceBytes + created + password)).
function buildSecurityHeader(username, password) {

  const nonceBytes = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto.createHash('sha1').update(Buffer.concat([ nonceBytes, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8') ])).digest('base64');

  return [

    '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"',
    ' xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">',
    '<wsse:UsernameToken>',
    '<wsse:Username>', escapeXml(username), '</wsse:Username>',
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">', digest,
    '</wsse:Password>',
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">', nonceBytes.toString('base64'),
    '</wsse:Nonce>',
    '<wsu:Created>', created, '</wsu:Created>',
    '</wsse:UsernameToken>',
    '</wsse:Security>',
  ].join('');
}

function escapeXml(str) {

  return String(str).replace(/[<>&'"]/g, ch => ({ '"': '&quot;', '&': '&amp;', "'": '&apos;', '<': '&lt;', '>': '&gt;' })[ch]);
}

// Build the full SOAP envelope. body is the action element (already namespace-qualified) that goes inside <s:Body>.
function buildEnvelope(body, username, password) {

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    '<s:Header>' + buildSecurityHeader(username, password) + '</s:Header>' +
    '<s:Body>' + body + '</s:Body>' +
    '</s:Envelope>';
}

// Strip XML namespace prefixes for easier regex extraction. ONVIF responses are deterministic enough that this beats wiring in a full XML parser.
function stripNamespaces(xml) {

  return xml.replace(/<\/?[a-zA-Z0-9]+:/g, m => m.startsWith('</') ? '</' : '<');
}

// Pull the text value out of the first <Tag>...</Tag> match. Returns null if not found.
function extractTag(xml, tag) {

  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]+)</' + tag + '>').exec(xml);

  return match ? match[1].trim() : null;
}

// POST a SOAP envelope and return the response body as a string. Rejects on non-2xx, network error, or timeout.
function soapPost(url, soapAction, body) {

  return new Promise((resolve, reject) => {

    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf8');

    const req = lib.request({

      headers: {

        'Content-Length': payload.length,
        'Content-Type': 'application/soap+xml; charset=utf-8; action="' + soapAction + '"',
      },
      hostname: u.hostname,
      method: 'POST',
      path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      rejectUnauthorized: false,
      timeout: SOAP_TIMEOUT_MS,
    }, (res) => {

      const chunks = [];
      let totalLength = 0;

      res.on('data', (chunk) => {

        totalLength += chunk.length;

        if(totalLength > SOAP_MAX_BYTES) {

          res.destroy();
          reject(new Error('ONVIF response exceeded ' + (SOAP_MAX_BYTES / (1024 * 1024)) + ' MB and was aborted.'));

          return;
        }

        chunks.push(chunk);
      });
      res.on('end', () => {

        const text = Buffer.concat(chunks).toString('utf8');

        if((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {

          resolve(text);
        } else {

          reject(new Error('HTTP ' + res.statusCode + (text ? ': ' + (extractTag(stripNamespaces(text), 'Reason') ?? extractTag(stripNamespaces(text), 'Text') ?? text.slice(0, 200)) : '')));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {

      req.destroy(new Error('ONVIF request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// GetCapabilities returns the URLs of the device's various services. We only need the Media XAddr.
async function getMediaServiceUrl(deviceServiceUrl, username, password) {

  const body = '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>Media</tds:Category></tds:GetCapabilities>';
  const response = await soapPost(deviceServiceUrl, 'http://www.onvif.org/ver10/device/wsdl/GetCapabilities', buildEnvelope(body, username, password));
  const stripped = stripNamespaces(response);

  // The Media block contains an XAddr element that points at the media service endpoint we'll send GetProfiles/GetStreamUri to.
  const mediaBlock = /<Media>([\s\S]*?)<\/Media>/.exec(stripped);

  if(!mediaBlock) {

    throw new Error('Camera did not return a Media service capability.');
  }

  const xAddr = extractTag(mediaBlock[1], 'XAddr');

  if(!xAddr) {

    throw new Error('Camera did not return a Media service XAddr.');
  }

  return xAddr;
}

// GetProfiles returns every available media profile so the UI can let the user pick the one they want (cameras typically expose at least a "main" /
// high-res and a "sub" / low-res profile, sometimes more). Each entry carries enough metadata - profile name, resolution, encoding - for the picker
// to be self-explanatory.
async function getProfiles(mediaServiceUrl, username, password) {

  const body = '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>';
  const response = await soapPost(mediaServiceUrl, 'http://www.onvif.org/ver10/media/wsdl/GetProfiles', buildEnvelope(body, username, password));
  const stripped = stripNamespaces(response);

  // Each <Profiles> element carries a token attribute and nested <Name>, <VideoEncoderConfiguration>{<Encoding>, <Resolution>{<Width>, <Height>}}.
  // We extract them with regex against the stripped XML - good enough for the deterministic ONVIF responses we deal with.
  const profileBlocks = [];
  const blockRe = /<Profiles\b([^>]*)>([\s\S]*?)<\/Profiles>/g;
  let match;

  while((match = blockRe.exec(stripped)) !== null) {

    const attrs = match[1];
    const inner = match[2];
    const tokenMatch = /\btoken="([^"]+)"/.exec(attrs);

    if(!tokenMatch) {

      continue;
    }

    const encoderBlock = /<VideoEncoderConfiguration\b[^>]*>([\s\S]*?)<\/VideoEncoderConfiguration>/.exec(inner)?.[1] ?? '';
    const resolutionBlock = /<Resolution\b[^>]*>([\s\S]*?)<\/Resolution>/.exec(encoderBlock)?.[1] ?? '';
    const width = extractTag(resolutionBlock, 'Width');
    const height = extractTag(resolutionBlock, 'Height');

    profileBlocks.push({

      encoding: extractTag(encoderBlock, 'Encoding'),
      name: extractTag(inner, 'Name'),
      resolution: (width && height) ? { height: Number(height), width: Number(width) } : null,
      token: tokenMatch[1],
    });
  }

  if(!profileBlocks.length) {

    throw new Error('Camera returned no media profiles.');
  }

  return profileBlocks;
}

// GetStreamUri returns the live RTSP URL for a given profile.
async function getStreamUri(mediaServiceUrl, profileToken, username, password) {

  const body =
    '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl">' +
    '<trt:StreamSetup>' +
    '<tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream>' +
    '<tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport>' +
    '</trt:StreamSetup>' +
    '<trt:ProfileToken>' + escapeXml(profileToken) + '</trt:ProfileToken>' +
    '</trt:GetStreamUri>';
  const response = await soapPost(mediaServiceUrl, 'http://www.onvif.org/ver10/media/wsdl/GetStreamUri', buildEnvelope(body, username, password));

  return extractTag(stripNamespaces(response), 'Uri');
}

// GetSnapshotUri returns the HTTP snapshot URL for a given profile.
async function getSnapshotUri(mediaServiceUrl, profileToken, username, password) {

  const body =
    '<trt:GetSnapshotUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl">' +
    '<trt:ProfileToken>' + escapeXml(profileToken) + '</trt:ProfileToken>' +
    '</trt:GetSnapshotUri>';
  const response = await soapPost(mediaServiceUrl, 'http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri', buildEnvelope(body, username, password));

  return extractTag(stripNamespaces(response), 'Uri');
}

// Normalize a hostname for comparison: lowercase, IPv6 brackets stripped, and alternate IPv4 spellings collapsed to dotted-quad by the WHATWG URL parser.
// Accepts either a bare host (as the user typed it) or a full URL's hostname. Returns null for anything unparseable.
function normalizeHost(host) {

  const trimmed = String(host ?? '').trim().replace(/^\[|\]$/g, '');

  if(!trimmed) {

    return null;
  }

  try {

    return new URL('http://' + ((net.isIP(trimmed) === 6) ? '[' + trimmed + ']' : trimmed)).hostname.replace(/^\[|\]$/g, '') || null;
  } catch {

    return null;
  }
}

// Check whether a URL returned by the camera points at the host the user entered. Ports are allowed to differ (cameras routinely serve RTSP, HTTP
// snapshots, and ONVIF on different ports); the hostname comparison is case-insensitive.
export function urlMatchesHost(uri, host) {

  const expected = normalizeHost(host);

  if(!expected) {

    return false;
  }

  try {

    return normalizeHost(new URL(uri).hostname) === expected;
  } catch {

    return false;
  }
}

// Inject the user-supplied credentials into the URL returned by ONVIF, since most cameras hand back a URL without embedded auth even though every
// stream/snapshot request needs to authenticate. Credentials are only ever injected into URLs that point back at the host the user entered - a camera
// (or anything impersonating one) returning a URL on some other host must not be able to harvest them. Any credentials the camera embedded itself in a
// foreign URL are stripped as well. Returns { url, credentialsWithheld }.
export function injectCredentials(uri, username, password, host) {

  if(!uri) {

    return { credentialsWithheld: false, url: uri };
  }

  let u;

  try {

    u = new URL(uri);
  } catch {

    return { credentialsWithheld: false, url: uri };
  }

  if(!urlMatchesHost(uri, host)) {

    u.username = '';
    u.password = '';

    return { credentialsWithheld: Boolean(username), url: u.toString() };
  }

  if(username) {

    u.username = encodeURIComponent(username);
    u.password = encodeURIComponent(password ?? '');
  }

  return { credentialsWithheld: false, url: u.toString() };
}

// Decide which media service URL we will actually send authenticated SOAP requests to. If the camera's advertised XAddr points at the host the user
// entered we use it as-is. Otherwise (a NAT'd camera reporting its internal IP, or a hostile device trying to redirect us) we keep the advertised path
// but send it to the user's host and the port that answered the device service. Returns { url, rewritten }.
export function resolveMediaServiceUrl(xAddr, host, port) {

  if(urlMatchesHost(xAddr, host)) {

    return { rewritten: false, url: xAddr };
  }

  let path = '/onvif/media_service';

  try {

    const u = new URL(xAddr);

    path = u.pathname + u.search;
  } catch {

    // Fall back to the conventional media service path if the camera returned something unparseable.
  }

  const hostPart = (net.isIP(normalizeHost(host) ?? '') === 6) ? '[' + normalizeHost(host) + ']' : host;

  return { rewritten: true, url: 'http://' + hostPart + ':' + port + path };
}

// Run the full discovery flow against a single host:port. Throws if anything goes wrong - the caller is expected to walk through fallback ports.
// Returns one entry per profile, each carrying its own RTSP and snapshot URL plus the metadata the UI uses to label the picker.
async function discoverAt(host, port, servicePath, username, password) {

  const hostPart = (net.isIP(host) === 6) ? '[' + host + ']' : host;
  const deviceServiceUrl = 'http://' + hostPart + ':' + port + servicePath;
  const warnings = [];
  const media = resolveMediaServiceUrl(await getMediaServiceUrl(deviceServiceUrl, username, password), host, port);
  const mediaServiceUrl = media.url;

  if(media.rewritten) {

    warnings.push('The camera advertised its media service on a different host. Using ' + host + ' instead.');
  }

  const profiles = await getProfiles(mediaServiceUrl, username, password);

  // Fan out per profile so we can fetch all stream and snapshot URLs in a single round of parallelism. Individual profile failures are tolerated -
  // we still want to surface the profiles that did work.
  const results = await Promise.all(profiles.map(async (profile) => {

    const [ rtspUri, snapshotUri ] = await Promise.all([

      getStreamUri(mediaServiceUrl, profile.token, username, password).catch(() => null),
      getSnapshotUri(mediaServiceUrl, profile.token, username, password).catch(() => null),
    ]);

    const rtsp = injectCredentials(rtspUri, username, password, host);
    const snapshot = injectCredentials(snapshotUri, username, password, host);

    return {

      ...profile,
      credentialsWithheld: rtsp.credentialsWithheld || snapshot.credentialsWithheld,
      rtspUrl: rtsp.url,
      snapshotUrl: snapshot.url,
    };
  }));

  if(results.some(profile => profile.credentialsWithheld)) {

    warnings.push('The camera returned stream or snapshot URLs on a different host than ' + host + '. Credentials were not added to those URLs.');
  }

  return { profiles: results, warnings };
}

// Public entry point. Tries the user-supplied port first (or each common port), then falls back to other common ONVIF ports if the connection fails.
// Authentication failures are NOT retried across ports - they bubble up immediately so the user sees the real reason.
export async function discoverOnvifEndpoints({ host, port, servicePath, username, password }) {

  if(!host || !username) {

    throw new Error('host and username are required.');
  }

  const path = (servicePath?.trim() || DEFAULT_SERVICE_PATH).replace(/^(?!\/)/, '/');
  const portsToTry = port ? [ port, ...DEFAULT_ONVIF_PORTS.filter(p => p !== port) ] : DEFAULT_ONVIF_PORTS;
  const attempts = [];

  for(const candidate of portsToTry) {

    try {

      const result = await discoverAt(host, candidate, path, username, password);

      return { ...result, attempts, port: candidate, servicePath: path };
    } catch(err) {

      const message = err instanceof Error ? err.message : String(err);

      attempts.push({ error: message, port: candidate });

      // Re-throw immediately on authentication errors - those won't get better at a different port.
      if(/sender not authorized|notauthorized|unauthorized|wsse|password/i.test(message)) {

        throw err;
      }
    }
  }

  // No port worked. Build a single message that lists everything tried so the user can see the actual cause for each candidate (typically all
  // ECONNREFUSED, meaning ONVIF isn't enabled or runs on a non-standard port).
  const summary = attempts.map(a => 'port ' + a.port + ': ' + a.error).join('; ');

  throw new Error('No reachable ONVIF service on ' + host + path + ' (' + summary + ').');
}
