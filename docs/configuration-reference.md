<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/mp-consulting/homebridge-unifi-protect/main/docs/media/homebridge-unifi-protect.svg)](https://github.com/mp-consulting/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/@mp-consulting/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/camera-security) device ecosystem. [UniFi Protect](https://ui.com/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Configuration Reference

This is a complete reference of the HBUP settings JSON. The defaults should work well for almost everyone and configuration of this plugin should be done exclusively within the HBUP webUI and not manually editing JSONs which can be error-prone and lead to undesired behavior.

```js
"platforms": [
  {
    "platform": "UniFi Protect",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "verboseFfmpeg": false,
    "ringDelay": 0,
    "debug": false,

    "options": [
      "Enable.Motion.Switch"
    ],

    "controllers": [
      {
        "name": "My UniFi Protect Controller",
        "address": "1.2.3.4",
        "overrideAddress": "a.b.c.d",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password",
        "doorbellMessages": [
          {
             "message": "Be right there.",
             "duration": 90
          }
        ],
        "mqttUrl": "mqtt://test.mosquitto.org",
        "mqttTopic": "unifi/protect",
        "verifyTls": false,
        "playlistAddress": "127.0.0.1",
        "playlistToken": "some-long-random-string"
      }
    ]
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `UniFi Protect`.                         | UniFi Protect                                                                         | Yes      |
| address                | Host or IP address of your UniFi Protect controller.    |                                                                                       | Yes      |
| username               | Your UniFi Protect username.                            |                                                                                       | Yes      |
| password               | Your UniFi Protect password.                            |                                                                                       | Yes      |
| overrideAddress        | Override the address used when HBUP accesses camera URLs.|                                                                                      | No       |
| doorbellMessages       | Configure [doorbell messages](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/doorbell.md) for your UniFi Protect controller. | [] | No |
| ringDelay              | Delay between doorbell rings. Setting this to a non-zero value will prevent multiple rings of a doorbell over the specified duration. | 0                                                                                     | No       |
| videoProcessor         | Specify path of ffmpeg. HBUP uses it's own ffmpeg version, and in general you should not specify a different one unless there is a specific need. | builtin or falling back to "ffmpeg" in your PATH. | No       |
| options                | Configure plugin [feature options](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/feature-options.md).   | []                 | No       |
| name                   | Controller name to use for homebridge logging purposes. | UniFi Protect controller name                                                         | No       |
| mqttUrl                | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user:password@1.2.3.4`. |                                              | No       |
| mqttTopic              | The base topic to use when publishing MQTT messages.    | "unifi/protect"                                                                       | No       |
| verboseFfmpeg          | Enable additional logging for video streaming.          | false                                                                                 | No       |
| debug                  | Enable debug logging. This produces a large volume of log output and should only be used when troubleshooting. | false                          | No       |
| verifyTls              | Validate the controller's TLS certificate against trusted certificate authorities. Only enable this if your controller uses a certificate signed by a trusted authority. See [TLS certificate pinning](#tls-pinning). | false | No |
| playlistAddress        | Local IP address the M3U playlist service (the `Nvr.Service.Playlist` [feature option](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/feature-options.md)) listens on. | all interfaces | No |
| playlistToken          | Access token required to retrieve the M3U playlist. When set, clients must request the playlist using `http://<homebridge>:<port>/?token=<playlistToken>`. |                | No       |

### <A NAME="tls-pinning"></A>TLS Certificate Pinning
UniFi Protect controllers ship with self-signed TLS certificates, which can't be validated against a certificate authority. Unless you enable `verifyTls`, HBUP uses *trust on first use* instead: the first time it connects to a controller, it records the SHA-256 fingerprint of the controller's certificate and logs it. On every subsequent connection, the certificate must match that fingerprint - if it doesn't, HBUP refuses to connect before sending your login credentials, and logs an error showing the expected and received fingerprints.

Pinned fingerprints are stored per controller address in `unifi-protect-tls-pins.json` in your Homebridge storage directory (typically `~/.homebridge`).

If you have intentionally replaced the certificate on your controller, or a controller update regenerated it, you'll need to reset the pin: remove the entry for that controller's address from `unifi-protect-tls-pins.json` (or delete the file entirely to reset all controllers) and restart Homebridge. HBUP will then trust and pin the new certificate. If you did not expect the certificate to change, investigate before resetting the pin - a mismatch can indicate that someone is intercepting traffic between Homebridge and your controller.

Pinning protects every connection to the controller: HTTPS API requests (including login), and the realtime events, livestream, and two-way audio WebSocket connections. No credentials or session cookies are sent until the controller's certificate has been checked.

### <A NAME="playlist"></A>M3U Playlist Access
When the `Nvr.Service.Playlist` feature option is enabled, HBUP publishes an M3U playlist containing the RTSP stream URLs of your cameras. By default, it listens on all network interfaces and anyone who can reach the port can retrieve the playlist - HBUP logs a warning at startup when no access token is configured. To restrict access, set `playlistToken` and point your playlist app (e.g. Channels DVR) at `http://<homebridge>:<port>/?token=<playlistToken>`, and optionally set `playlistAddress` to limit which interface the service listens on.
