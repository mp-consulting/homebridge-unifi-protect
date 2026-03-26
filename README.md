<p align="center">
  <a href="https://github.com/mp-consulting/homebridge-unifi-protect">
    <img src="https://raw.githubusercontent.com/mp-consulting/homebridge-unifi-protect/main/docs/media/homebridge-unifi-protect.svg" alt="homebridge-unifi-protect" />
  </a>
</p>

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/@mp-consulting/homebridge-unifi-protect?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)

> Complete HomeKit support for the [UniFi Protect](https://ui.com/camera-security) ecosystem using [Homebridge](https://homebridge.io).

> Originally based on [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) by [HJD](https://github.com/hjdhjd), licensed under the ISC License. This fork has been substantially rewritten by [MP Consulting](https://github.com/mp-consulting).

## Overview

A [Homebridge](https://homebridge.io) plugin that brings native HomeKit support to [UniFi Protect](https://ui.com/camera-security) devices. Provide your controller's IP address and credentials, and every supported device is automatically discovered and made available in HomeKit — cameras, doorbells, sensors, chimes, lights, and viewports.

### Highlights

- **Zero-config device discovery** — devices are detected in realtime as they are added or removed from your Protect controller.
- **[HomeKit Secure Video](docs/homekit-secure-video.md)** — full HKSV support for all Protect cameras, including third-party cameras paired with an AI Port.
- **High-performance streaming** — hardware-accelerated live streams load in 0.2-0.3 s on Apple Silicon/Intel QSV; 1-2 s without acceleration.
- **[Doorbell support](docs/doorbell.md)** — ring notifications, two-way audio, package cameras, and LCD message presets.
- **[Smart motion & occupancy](docs/feature-options.md)** — motion and occupancy sensors with smart object filtering (person, vehicle, animal, etc.).
- **[Liveview scenes](docs/liveviews.md)** — map Protect liveviews to HomeKit security system presets and motion-detection switches.
- **[MQTT integration](docs/mqtt.md)** — publish realtime events to any MQTT broker.
- **UniFi Access lock control** — unlock Access-paired doors directly from HomeKit.
- **Multi-controller** — connect multiple Protect controllers in a single plugin instance.

## Requirements

| Requirement | Version |
|---|---|
| [Homebridge](https://homebridge.io) | >= 1.8.0 |
| Node.js | >= 20 |
| UniFi Protect | v6+ (including v7) |
| FFmpeg | Bundled, or any build with **fdk-aac** support |

> [!IMPORTANT]
> Only official (non-beta, non-early-access) releases of UniFi Protect firmware and hardware are supported. Beta versions of Apple operating systems are also unsupported.

## Quick Start

1. Install the plugin through the Homebridge UI, or via the CLI:

   ```sh
   npm install -g @mp-consulting/homebridge-unifi-protect
   ```

2. Add a platform entry to your Homebridge `config.json`:

   ```json
   {
     "platforms": [
       {
         "platform": "UniFi Protect",
         "controllers": [
           {
             "address": "192.168.1.1",
             "username": "homebridge",
             "password": "your-password"
           }
         ]
       }
     ]
   }
   ```

3. Restart Homebridge. Your Protect devices will appear in HomeKit automatically.

For detailed setup instructions, see the [Getting Started](docs/getting-started.md) guide.

## Documentation

| | |
|---|---|
| **[Getting Started](docs/getting-started.md)** | Installation, configuration, and first-run walkthrough |
| **[Feature Options](docs/feature-options.md)** | Granular per-device and per-controller behavior options |
| **[HomeKit Secure Video](docs/homekit-secure-video.md)** | HKSV setup and optimization |
| **[Doorbells](docs/doorbell.md)** | Two-way audio, ring events, LCD messages |
| **[Liveview Scenes](docs/liveviews.md)** | Security system presets and motion-detection switches |
| **[MQTT](docs/mqtt.md)** | Event publishing to an MQTT broker |
| **[Audio Options](docs/audio-options.md)** | Noise filter tuning for outdoor environments |
| **[Autoconfiguration](docs/autoconfiguration.md)** | How transcoding and transmuxing are auto-selected |
| **[Best Practices](docs/best-practices.md)** | Recommendations for the best HomeKit experience |
| **[Configuration Reference](docs/configuration-reference.md)** | Full JSON schema and field descriptions |
| **[Troubleshooting](docs/troubleshooting.md)** | Diagnosing login, network, and streaming issues |
| **[Realtime Events API](docs/events.md)** | Protocol internals and event processing pipeline |
| **[Changelog](CHANGELOG.md)** | Release history |

## Supported Devices

All generally available UniFi Protect hardware is supported:

- **Cameras** — G3, G4, G5, G6, AI Pro series (with tamper detection on supported models)
- **Doorbells** — all UniFi Protect doorbells
- **Sensors** — motion, contact, and leak sensors, including SuperLink
- **Chimes**
- **Lights**
- **Viewports**
- **Third-party ONVIF cameras** — with full HKSV when paired with an AI Port

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run clean` | Remove the `dist/` directory |
| `npm run lint` | Run ESLint with zero-warnings policy |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run watch` | Build, link, and watch for changes (nodemon) |
| `npm run start` | Build and launch Homebridge with a test config |
| `npm run monitor:events` | Run the event schema monitor script |

## Contributing

Contributions are welcome. Please open an issue first to discuss your proposed changes.

```sh
git clone https://github.com/mp-consulting/homebridge-unifi-protect.git
cd homebridge-unifi-protect
npm install
npm run build
npm test
```

## License

Original work by [HJD](https://github.com/hjdhjd) under [ISC](LICENSE.md). Modifications by Mickael Palma under [MIT](LICENSE.md).

## Development

[![Build Status](https://img.shields.io/github/actions/workflow/status/mp-consulting/homebridge-unifi-protect/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/mp-consulting/homebridge-unifi-protect/actions?query=workflow%3A%22Continuous+Integration%22)
[![License](https://img.shields.io/npm/l/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/LICENSE.md)
[![Dependencies](https://img.shields.io/librariesio/release/npm/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/@mp-consulting/homebridge-unifi-protect)
