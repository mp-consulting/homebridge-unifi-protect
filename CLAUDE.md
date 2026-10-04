# CLAUDE.md

## Project Overview

Homebridge plugin (`@mp-consulting/homebridge-unifi-protect`) providing full HomeKit support for the UniFi Protect ecosystem. Supports cameras (with HKSV), doorbells, sensors, chimes, lights, viewers, and third-party ONVIF cameras. Features high-performance hardware-accelerated streaming, smart motion/occupancy detection, MQTT event publishing, and UniFi Access lock integration.

## Tech Stack

- **Language**: TypeScript (strict, ES2022, ESM via NodeNext)
- **Runtime**: Node.js >= 22, Homebridge >= 1.8.0
- **Testing**: Vitest with v8 coverage
- **Linting**: ESLint 9 flat config with typescript-eslint
- **Dependencies**: The plugin itself needs none at runtime (the webUI server's Assistant routes use `@mp-consulting/homebridge-ai-kit`, the only required dependency) — the UniFi Protect API client (`src/unifi/`) and plugin utilities incl. the FFmpeg pipeline (`src/lib/`) are implemented in-repo on Node.js built-ins. `ffmpeg-for-homebridge` is an *optional* dependency resolved dynamically; when absent, FFmpeg comes from the system or the `videoProcessor` config option.

## Commands

- `npm run build` — Clean and compile TypeScript
- `npm run lint` — Lint with zero warnings
- `npm test` — Run tests (Vitest)
- `npm run test:coverage` — Tests with coverage
- `npm run watch` — Build, link, and rerun Homebridge on changes (node --watch, scripts/watch.mjs)
- `npm run start` — Build and launch Homebridge with test config
- `npm run monitor:events` — Run event schema monitor script

## Project Structure

```
src/
├── index.ts                    # Plugin entry point
├── settings.ts                 # Constants & configuration
├── protect-platform.ts         # ProtectPlatform (DynamicPlatformPlugin)
├── protect-nvr.ts              # NVR controller management
├── protect-events.ts           # WebSocket event handling
├── protect-stream.ts           # Video streaming pipeline (RTP/RTCP)
├── protect-talkback.ts         # Two-way audio (return audio) for streaming sessions
├── protect-probesize.ts        # FFmpeg probesize auto-tuning
├── protect-livestream.ts       # Livestream API wrapper
├── protect-record.ts           # HKSV recording management
├── protect-snapshot.ts         # Snapshot caching
├── protect-timeshift.ts        # Timeshift buffer (fMP4 segments)
├── protect-playlist.ts         # M3U playlist server (optional bind address and access token)
├── protect-options.ts          # Feature options & config types
├── protect-types.ts            # Type definitions & enums
├── protect-utils.ts            # Utility functions
├── lib/                        # Dependency-free utility library (feature options, MQTT client, HTTPS/WebSocket transports, HomeKit service helpers, UI server)
│   └── ffmpeg/                 # FFmpeg pipeline (codecs, options, hwaccel backends, fMP4/recording/livestream processes, RTP demuxer/ports, fMP4 parsing)
├── unifi/                      # UniFi Protect API client built on src/lib transports
│   ├── protect-api.ts          # ProtectApi facade (bootstrap, device commands)
│   ├── protect-api-session.ts  # Login, cookies, CSRF
│   ├── protect-api-http.ts     # Request/retry logic, with protect-api-circuit-breaker.ts throttling
│   ├── protect-api-events-channel.ts  # Realtime events WebSocket
│   └── protect-api-tls.ts      # TLS trust-on-first-use certificate pinning (pins persisted by protect-tls-pin-store.ts)
└── devices/
    ├── protect-device.ts       # Base device class
    ├── protect-camera.ts       # Camera accessory (composes camera-controls, camera-sensors, camera-video delegates)
    ├── protect-doorbell.ts     # Doorbell wiring (delegates: protect-doorbell-messages.ts, protect-doorbell-chimes.ts)
    ├── protect-accessory-context.ts  # Typed accessory.context
    ├── protect-sensor.ts       # Motion/alarm/leak sensors (incl. SuperLink)
    ├── protect-light.ts        # Light/LED control
    ├── protect-chime.ts        # Chime accessory
    ├── protect-viewer.ts       # Viewport device
    ├── protect-liveviews.ts    # Liveview scene management
    ├── protect-camera-package.ts  # Package camera logic
    ├── protect-nvr-systeminfo.ts  # System info service
    └── protect-securitysystem.ts  # Security system accessory
test/
├── *.test.ts                   # Unit tests
└── hbConfig/                   # Homebridge test config
docs/                           # 12 guides (kebab-case filenames)
homebridge-ui/                  # Custom config UI with discovery & feature options
├── server.js                   # webUI server (imports the compiled plugin from ../dist)
├── assistant.js                # Assistant routes (/ai/*, from @mp-consulting/homebridge-ai-kit/plugin) + UniFi Protect system context
└── public/modules/assistant.js # Client-side Assistant: Explain buttons, error scrubbing, device/controller whitelists
```

The Assistant UI (`MpKit.ai`) only appears when `/ai/status` reports it enabled. Never send controller or camera credentials, addresses, API keys,
MACs or IPs to it: use `assistantDevice()` / `assistantController()` (whitelists) and `scrubText()`. `public/lib/` is generated by
`mp-ui-kit-copy --vendor` (gitignored). Tests: `test/ui-assistant.test.ts`.

## Architecture

- **Platform → NVR → Device** hierarchy with multi-controller support
- **Device class tree**: ProtectDevice → ProtectCamera → ProtectDoorbell
- **Event-driven**: WebSocket real-time events from Protect controller
- **Streaming pipeline**: FFmpeg-based with hardware acceleration (Apple Silicon, Intel QSV, RPi4)
- **HKSV**: Timeshift buffer with fMP4 segments, smart object filtering
- **Feature options**: Category-based (Audio, Device, Doorbell, Motion, Video, HKSV) with per-device granularity
- **MQTT**: Real-time event publishing (motion, doorbell, smart objects, snapshots)
- **Custom UI**: Uses Homebridge custom UI framework (`homebridge-ui/`) for plugin configuration management

## Key Constants (settings.ts)

- Motion timeout: 10 seconds
- Occupancy timeout: 300 seconds
- HKSV timeshift: 10 seconds (dual I-frame)
- Streaming bitrates: 2000 kbps (local), 1000 kbps (high-latency)
- HKSV communication timeout: 4.5 seconds

## Conventions

- HomeKit `onSet` handlers that write to Protect use `ProtectDevice.writeDevice()`, which throws `HapStatusError` on failure so HomeKit reverts the UI.
- Event subscriptions go through `ProtectBase.subscribe()` so `cleanup()` removes them; clear any timers a device owns in its `cleanup()` override.
- Doorbell/camera state set from `configureDevice()` (called inside the parent constructor) must use `declare` fields - ES2022 class fields would reset them.
- `src/lib/{featureoptions,mqtt-connection,mqttclient,request,service,ui-server,util,websocket}.ts` must stay byte-identical with homebridge-unifi-access
  (`scripts/check-lib-sync.sh` runs in CI).
- `npm run typecheck` type-checks both src and test (tsconfig.test.json); CI runs coverage with thresholds from vitest.config.mts.

## Code Style

- Single quotes, 2-space indent, semicolons required
- Trailing commas in multiline, max line length 160
- Unix line endings, object curly spacing
- File naming: `protect-[component].ts`
- Copyright headers: dual-line — `Copyright(C) 2017-2026, HJD` then `Copyright(C) 2026, Mickael Palma / MP Consulting`

## Git Settings

- `coAuthoredBy`: false
