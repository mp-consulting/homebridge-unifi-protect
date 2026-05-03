<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/mp-consulting/homebridge-unifi-protect/main/docs/media/homebridge-unifi-protect.svg)](https://github.com/mp-consulting/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/@mp-consulting/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)

## Streaming ONVIF / third-party cameras adopted into UniFi Protect.
</DIV>
</SPAN>

UniFi Protect can adopt ONVIF and other third-party cameras. Once adopted, these cameras appear in HomeKit through this plugin alongside native UniFi cameras. However, the way the Protect controller exposes their video streams differs from how it exposes native UniFi cameras, and that difference often prevents HomeKit from being able to render their livestream.

This guide explains the constraints, why they exist, and the configuration options that allow you to work around them.

### Why third-party cameras need extra configuration

Native UniFi cameras stream through the Protect controller. The controller exposes a single secure RTSP endpoint (typically `rtsps://<nvr>:7441/<alias>`) that HomeKit can pull from. The plugin uses this endpoint exclusively for native cameras.

ONVIF and other third-party cameras are different in two important ways:

1. **HomeKit Secure Video is not supported.** HKSV requires the timeshift buffer fed by the Protect livestream API, and that API is only available for native UniFi cameras. The plugin gates HKSV on `isHksvCapable`, which is never true for an ONVIF camera unless paired with a UniFi AI Port.
2. **The Protect controller frequently does not relay the camera's stream over its own RTSPS endpoint.** Even though Protect reports `isRtspEnabled: true` on every channel of an ONVIF camera, attempting to read from `rtsps://<nvr>:7441/<rtspAlias>` typically returns no response and the connection is closed. The native livestream API and timeshift buffer are also unavailable, leaving no path for the plugin to retrieve video from the Protect controller for these cameras.

The practical consequence is that the plugin has no working stream source for an ONVIF camera until it is told where the camera's own RTSP endpoint lives.

### How to confirm the controller is not relaying the stream

From the Homebridge host, with FFmpeg installed:

```bash
ffmpeg -rtsp_transport tcp -i 'rtsps://<nvr-ip>:7441/<rtspAlias>?enableSrtp' -t 3 -f null -
```

Replace `<nvr-ip>` with the controller IP and `<rtspAlias>` with the value visible in the Protect API for the camera channel. If FFmpeg fails to read frames, the controller is not relaying the stream and you need to configure the override URLs described below.

### Configuration options

Both options are exposed in the Homebridge custom UI on a per-camera basis, under the **Video** category, and are only available for cameras that the Protect controller has flagged as third-party.

#### `Video.Stream.RtspOverride`

Full RTSP or RTSPS URL pointing directly at the camera's own RTSP server, bypassing the Protect controller. Credentials may be embedded in the URL. When set, the plugin uses this URL for every HomeKit livestream request and skips the controller-side relay setup entirely.

Example:

```
rtsp://username:password@192.168.2.100:8555/c675d_wide
```

The override URL is treated as a single source. The plugin still uses the channel metadata reported by Protect (resolution, frame rate, codec) to advertise capabilities to HomeKit, but every stream HomeKit requests is fulfilled from the override URL.

#### `Video.Snapshot.UrlOverride`

Full HTTP or HTTPS URL pointing at the camera's snapshot endpoint, bypassing the Protect controller. Credentials may be embedded in the URL. When set, snapshot requests are served from this URL first, falling back to the regular RTSP and Protect API paths only if the override request fails.

Example:

```
http://192.168.2.100:8681/wide
```

Self-signed HTTPS certificates are accepted on the override URL since most third-party cameras ship with non-public certs.

### What is not supported

This plugin only consumes the RTSP and HTTP endpoints you provide. It does not:

- Subscribe to ONVIF events. Motion, smart detection, and doorbell events still come from the Protect controller, so they will continue to be limited by what Protect detects on the third-party camera.
- Control PTZ.
- Provide HomeKit Secure Video recording for ONVIF cameras (see HKSV note above).
- Probe the camera to discover stream URLs automatically. You must supply them.

### Troubleshooting

If the override URL is configured but HomeKit still cannot render the stream:

- Verify the URL works in VLC or with `ffmpeg -rtsp_transport tcp -i '<url>' -t 3 -f null -` from the Homebridge host.
- Confirm the Homebridge host can route to the camera's IP and port. ONVIF cameras and the NVR are often on different subnets.
- Check the Homebridge log for warnings emitted by this plugin when it could not configure the stream. Set the `Debug.Video.Startup` feature option for additional detail on RTSP entry mapping.
- If two-way audio, smart motion, or recording behavior also matters for the camera, consider whether full ONVIF integration via a dedicated plugin (alongside this one) is a better fit for your setup.
