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
- **[Assistant](#assistant) (optional)** — explains controller connection, device and ONVIF discovery problems in the webUI, using the AI provider you set up in Homebridge AI Kit.

## Requirements

| Requirement | Version |
|---|---|
| [Homebridge](https://homebridge.io) | >= 1.8.0 |
| Node.js | >= 20 |
| UniFi Protect | v6+ (including v7) |
| FFmpeg | Bundled (optional dependency), your system FFmpeg, or any build with **fdk-aac** support configured through the `videoProcessor` option |

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
         "name": "UniFi Protect",
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

## Assistant

The webUI can explain problems with the **Assistant**. It is off until you set up an AI
provider once for all MP Consulting plugins in
[Homebridge AI Kit](https://github.com/mp-consulting/homebridge-ai-kit) (or the Homebridge
Glass UI): the plugin reads the shared `HomebridgeAiKit` platform block from `config.json`
and has no AI settings of its own. When it is not set up, the webUI looks exactly as before,
with a small tip under the list of controllers.

When it is enabled, an **Explain** button appears next to:

- a controller that fails to connect when you add or edit it (login, privileges, timeout,
  unreachable or refused address),
- a controller shown as **Offline** in the controller list,
- an empty or failed discovery,
- a controller whose devices cannot be loaded on the feature options screen,
- a device that is not connected or is updating, on the feature options screen,
- a failed ONVIF discovery for a third-party camera.

The answer streams into an Assistant panel below, with UniFi Protect context (local users and
roles, the plugin's error messages, TLS pinning, discovery, ONVIF, streaming).

What is sent to the provider: the error message with the controller or camera address, IP
addresses and MAC addresses replaced by placeholders; for a controller only its name and
whether TLS verification is on; for a device its name, model, type, firmware, connection
type and state flags. The controller address, username and password, camera (ONVIF)
addresses and credentials, and device IP addresses, MAC addresses and IDs are never sent, and
the provider's API key stays on the Homebridge server.

There is no "Describe Your Setup" here: the configuration is the list of controllers (with
credentials), camera overrides and feature options, which the webUI manages.

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
| `npm run watch` | Build, link, and rerun Homebridge when src/ or homebridge-ui/ change |
| `npm run start` | Build and launch Homebridge with a test config |
| `npm run monitor:events` | Run the event schema monitor script |

## Why This Fork?

This project is a fork of [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) by [HJD](https://github.com/hjdhjd). We are grateful for HJD's foundational work and the community that has grown around it.

The fork was created to pursue a different set of engineering goals that required changes too broad and opinionated to propose as pull requests to the original project:

- **Substantial rewrites** — large portions of the codebase have been restructured or rewritten for performance, maintainability, and strict TypeScript usage. Changes of this scope and nature are not well-suited to incremental upstream PRs.
- **Different architectural direction** — decisions around module boundaries, streaming pipeline design, and dependency choices diverge from the original project's approach.
- **Independent release cadence** — maintaining a separate fork allows us to ship features, fixes, and refactors on our own schedule without waiting for upstream review cycles.

### Relationship with the original project

- The original project remains independently maintained and is an excellent choice for many users.
- We do not currently submit changes back upstream, as the codebases have diverged significantly.
- We may selectively incorporate upstream bug fixes or features when they are relevant and compatible.
- Our roadmap is driven by our own priorities and community feedback — see [Issues](https://github.com/mp-consulting/homebridge-unifi-protect/issues) for what is planned or under discussion.

## Contributing

Contributions are welcome. Please open an issue first to discuss your proposed changes.

```sh
git clone https://github.com/mp-consulting/homebridge-unifi-protect.git
cd homebridge-unifi-protect
npm install
npm run build
npm test
```

The build vendors `@mp-consulting/homebridge-ui-kit` and Bootstrap into
`homebridge-ui/public/lib/` with `mp-ui-kit-copy --vendor`. Until
`@mp-consulting/homebridge-ai-core` 2.0.0 and `@mp-consulting/homebridge-ui-kit` 1.2.0
are published, both are installed from sibling checkouts (`file:../homebridge-mcp-server/packages/ai-core`
and `file:../homebridge-ui-kit`); they must become `^2.0.0` and `^1.2.0` before release.

## License

Original work by [HJD](https://github.com/hjdhjd) under [ISC](LICENSE.md). Modifications by Mickael Palma under [MIT](LICENSE.md).

## Development

[![Build Status](https://img.shields.io/github/actions/workflow/status/mp-consulting/homebridge-unifi-protect/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/mp-consulting/homebridge-unifi-protect/actions?query=workflow%3A%22Continuous+Integration%22)
[![License](https://img.shields.io/npm/l/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/LICENSE.md)
[![Dependencies](https://img.shields.io/librariesio/release/npm/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/@mp-consulting/homebridge-unifi-protect)
