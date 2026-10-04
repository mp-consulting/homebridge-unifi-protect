/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * assistant.js: @mp-consulting/homebridge-unifi-protect webUI Assistant routes.
 */
import { registerAiRoutes } from '@mp-consulting/homebridge-ai-kit/plugin';

export const ASSISTANT_PLUGIN_NAME = '@mp-consulting/homebridge-unifi-protect';

// UniFi Protect background the Assistant gets with every request from this plugin's webUI. Keep it short: it is sent with each prompt. The facts come from
// src/unifi (protect-api-http.ts, protect-api-tls.ts, protect-api.ts), homebridge-ui/server.js, homebridge-ui/onvif.js and docs/troubleshooting.md.
export const UNIFI_PROTECT_AI_CONTEXT = [
  'The plugin bridges a UniFi Protect controller (a UniFi OS console or NVR running Protect v6 or later; official releases only, no betas) and its cameras,',
  'doorbells, sensors, chimes, lights and viewers, plus third-party ONVIF cameras adopted in Protect, to HomeKit, with FFmpeg-based streaming, HomeKit',
  'Secure Video (HKSV), realtime events over the controller\'s events WebSocket and optional MQTT publishing.',
  'Each entry in "controllers" has an address, username and password; it connects locally over HTTPS (port 443) to the UniFi OS API. It needs a local',
  'user on the console (Ubiquiti.com/UI.com cloud accounts and two-factor authentication are not supported); the Full Management role gives every',
  'feature, at least view-only is needed to see cameras, and enabling RTSP streams needs the Administrator role ("Insufficient privileges to enable',
  'RTSP"). Common errors: "Invalid login credentials given" is HTTP 401 (wrong username or password, or a cloud account); "Insufficient privileges for',
  'this user" is HTTP 403; "Unable to connect to the Protect controller. This is temporary and may occur during device reboots." covers 400, 404, 429 and',
  '5xx answers (Protect not installed, updating or restarting); "Connection refused", "Connection timed out" and "Hostname or IP address not found" mean',
  'a wrong address or a console unreachable from Homebridge (VLAN, firewall, Docker networking); "Protect controller is taking too long to respond" is a',
  '3.5 second request timeout; after 10 consecutive errors the plugin pauses API calls for 5 minutes ("Throttling API calls"). The settings webUI gives a',
  'controller 20 seconds to log in and bootstrap ("Timed out after 20s waiting for ... to respond") and refuses loopback and link-local addresses',
  '("Connections to ... are not permitted"). TLS: by default ("verifyTls" off) the console\'s self-signed certificate is pinned on first connection',
  '(trust on first use) in unifi-protect-tls-pins.json in the Homebridge storage directory; "does not match the pinned certificate" or "Refusing TLS',
  'connection" means the certificate was regenerated (remove that controller\'s entry and restart Homebridge) or the connection is being intercepted.',
  '"verifyTls" on requires a CA-signed certificate. Discovery uses the Ubiquiti discovery protocol (UDP port 10001) on local and nearby subnets, so',
  'consoles behind routers may need to be added by address. A device whose state is not CONNECTED is offline in Protect itself (power, PoE, Wi-Fi,',
  'adoption). Third-party cameras get their RTSP and snapshot URLs from ONVIF discovery, which tries ports 80, 8000, 8080, 2020 and 8899 on',
  '/onvif/device_service; "No reachable ONVIF service" usually means ONVIF is disabled on the camera or uses another port or path, and authorization',
  'errors mean wrong camera (ONVIF) credentials. "Snapshots work but video streaming does not" is almost always the advertised network interface in',
  'Homebridge (Docker, VMs, several NICs). Streaming needs FFmpeg with fdk-aac (bundled, system, or the "videoProcessor" option). Feature options',
  '("options") enable or disable features per controller or device. Never ask the user for their controller or camera password, API keys or tokens.',
].join(' ');

// Adds the Assistant routes (/ai/status, /ai/explain, /ai/ask, /ai/config) to the webUI server. The provider settings come from the shared HomebridgeAiKit
// block in config.json; the key never reaches the browser. `options` is passed through to registerAiRoutes (tests inject a provider).
export function registerAssistant(server, options = {}) {

  registerAiRoutes(server, {

    pluginName: ASSISTANT_PLUGIN_NAME,
    systemContext: UNIFI_PROTECT_AI_CONTEXT,
    ...options,
  });
}
