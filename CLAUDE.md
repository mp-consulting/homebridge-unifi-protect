# CLAUDE.md

## Project Overview

Homebridge plugin (`@mp-consulting/homebridge-unifi-protect`) providing full HomeKit support for the UniFi Protect ecosystem. Supports cameras (with HKSV), doorbells, sensors, chimes, lights, viewers, and third-party ONVIF cameras. Features high-performance hardware-accelerated streaming, smart motion/occupancy detection, MQTT event publishing, and UniFi Access lock integration.

## Tech Stack

- **Language**: TypeScript (strict, ES2022, ESM via NodeNext)
- **Runtime**: Node.js >= 20, Homebridge >= 1.8.0
- **Testing**: Vitest with v8 coverage
- **Linting**: ESLint 9 flat config with typescript-eslint
- **Key deps**: `unifi-protect` (API client), `homebridge-plugin-utils` (HBUP utilities), `ffmpeg-for-homebridge` (video), `undici` (HTTP)

## Commands

- `npm run build` — Clean and compile TypeScript
- `npm run lint` — Lint with zero warnings
- `npm test` — Run tests (Vitest)
- `npm run test:coverage` — Tests with coverage
- `npm run watch` — Build, link, and watch with nodemon
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
├── protect-stream.ts           # Video streaming pipeline (RTP/RTCP, talkback)
├── protect-livestream.ts       # Livestream API wrapper
├── protect-record.ts           # HKSV recording management
├── protect-snapshot.ts         # Snapshot caching
├── protect-timeshift.ts        # Timeshift buffer (fMP4 segments)
├── protect-playlist.ts         # M3U playlist server
├── protect-options.ts          # Feature options & config types
├── protect-types.ts            # Type definitions & enums
├── protect-utils.ts            # Utility functions
└── devices/
    ├── protect-device.ts       # Base device class
    ├── protect-camera.ts       # Camera accessory (largest file ~1700 lines)
    ├── protect-doorbell.ts     # Doorbell + package camera
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
```

## Architecture

- **Platform → NVR → Device** hierarchy with multi-controller support
- **Device class tree**: ProtectDevice → ProtectCamera → ProtectDoorbell
- **Event-driven**: WebSocket real-time events from Protect controller
- **Streaming pipeline**: FFmpeg-based with hardware acceleration (Apple Silicon, Intel QSV, RPi4)
- **HKSV**: Timeshift buffer with fMP4 segments, smart object filtering
- **Feature options**: Category-based (Audio, Device, Doorbell, Motion, Video, HKSV) with per-device granularity
- **MQTT**: Real-time event publishing (motion, doorbell, smart objects, snapshots)

## Key Constants (settings.ts)

- Motion timeout: 10 seconds
- Occupancy timeout: 300 seconds
- HKSV timeshift: 10 seconds (dual I-frame)
- Streaming bitrates: 2000 kbps (local), 1000 kbps (high-latency)
- HKSV communication timeout: 4.5 seconds

## Code Style

- Single quotes, 2-space indent, semicolons required
- Trailing commas in multiline, max line length 160
- Unix line endings, object curly spacing
- File naming: `protect-[component].ts`
- Copyright headers: dual-line — `Copyright(C) 2017-2026, HJD` then `Copyright(C) 2026, Mickael Palma / MP Consulting`

## Git Settings

- `coAuthoredBy`: false
