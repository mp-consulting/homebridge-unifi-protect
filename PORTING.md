# Porting Provenance

This plugin has **no required runtime dependencies**. Everything it needs beyond Node.js built-ins is implemented in-repo. Most of that code was ported from
upstream packages at specific versions, and this document records exactly where each piece came from, what was changed, and how to sync against upstream in the
future.

## Upstream baselines

| In-repo location | Ported from | Version | Upstream source |
|---|---|---|---|
| `src/unifi/` | `unifi-protect` | 4.29.0 | https://github.com/hjdhjd/unifi-protect |
| `src/lib/ffmpeg/` | `homebridge-plugin-utils` (ffmpeg subtree) | 1.35.0 | https://github.com/hjdhjd/homebridge-plugin-utils |
| `src/lib/featureoptions.ts`, `src/lib/mqttclient.ts`, `src/lib/service.ts`, `src/lib/util.ts` | `homebridge-plugin-utils` | 1.35.0 | https://github.com/hjdhjd/homebridge-plugin-utils |
| `src/lib/ui-server.ts` | `@homebridge/plugin-ui-utils` (server class) | 2.2.3 | https://github.com/homebridge/plugin-ui-utils |
| `src/lib/request.ts`, `src/lib/websocket.ts`, `src/lib/mqtt-connection.ts` | original implementations | — | replace `undici` and `mqtt` usage |

The `ffmpeg-for-homebridge` package remains as an *optional* dependency, resolved dynamically at runtime with a fallback to the system FFmpeg
(`src/protect-platform.ts`).

## Transport replacement

Upstream `unifi-protect` was built on undici. The port replaces that transport with in-repo primitives:

- undici `Pool` with `connect: { rejectUnauthorized: false }` → `https.Agent({ keepAlive: true, maxSockets: 5, rejectUnauthorized })`, recreated in `reset()`.
- undici's retry interceptor → the retry policy in `src/lib/request.ts`: `{ factor: 2, maxRetries: 5, maxTimeout: 1500, minTimeout: 100, statusCodes: [ 429,
  500, 502, 503, 504 ] }`. PATCH requests remain excluded from retries, preserving upstream's non-idempotency rationale.
- undici error classes → Node error `.code` checks (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EHOSTDOWN`, `ETIMEDOUT`), with timeouts driven by an
  `AbortController`.
- undici `WebSocket` (addEventListener / Blob / ArrayBuffer semantics) → `src/lib/websocket.ts`, an RFC 6455 client on Node's `http(s)` upgrade mechanism that
  delivers binary frames as Buffers (no async Blob conversion) and supports self-signed TLS endpoints.
- The undici user-agent interceptor → a `user-agent` header set during header initialization in `logout()`.

## Deliberate deviations from upstream

Everything not listed here is a faithful port. The deviations, all behavior-neutral unless noted:

### `src/unifi/` (from unifi-protect 4.29.0)

- `wsDispatcher` getter dropped — it exposed the undici WebSocket `Agent`, was marked `@internal`, and had no consumers.
- `RequestOptions` narrowed to `{ body?, method? }` — upstream accepted more fields, but `_retrieve` always overwrote headers and dispatcher.
- `launchEventsWs` no longer special-cases undici `TypeError`s or unsupported Blob message types (impossible with the local WebSocket client); all WebSocket
  errors are logged.
- The livestream's WebSocket listener cleanup uses `removeAllListeners()` in `stop()` to replicate upstream's abort-signal-based removal: a manual stop does not
  emit `close`, while server- or heartbeat-initiated closes do.
- `body.dump()` calls dropped — the local transport buffers responses fully.
- The CLI utility (`dist/util/ufp.js`) was not ported.
- Known upstream quirk preserved: after `stop()`, `ProtectLivestream.getInitSegment()` returns the stale cached (aborted) promise rather than the
  `'No active livestream session.'` error; only the next `start()` clears the cache. Documented by `test/livestream-protocol.test.ts`.
- **Added** (not in upstream): the `verifyTls` constructor option enabling strict TLS certificate validation across the API connection, events WebSocket, and
  livestream WebSocket.

### `src/lib/ffmpeg/` (from homebridge-plugin-utils 1.35.0)

- `rtp.ts`: `this._reserve(ipFamily, portCount, ++attempts)` → `attempts + 1` (lint: `no-useless-assignment`; the local was never read afterward).
- `record.ts`: `let offset = 0;` → `let offset: number;` and `options.ts`: `let encoderOptions = [];` → `let encoderOptions: string[];` (lint:
  `no-useless-assignment`; both are definitely assigned before every read).
- `record.ts`: `translateAudioSampleRate[...samplerate as AudioRecordingSamplerate]` — this hap-nodejs version types `samplerate` as possibly an array; the cast
  preserves upstream's exact runtime indexing.
- Comments rewrapped to ≤160 columns throughout (repo lint counts comments).

### `src/lib/` shared files (from homebridge-plugin-utils 1.35.0 / @homebridge/plugin-ui-utils 2.2.3)

- `MqttClient` is API-identical to upstream but runs on the in-repo `MqttConnection` (MQTT 3.1.1 over `net`/`tls`) instead of the `mqtt` package.
- **Added** (not in upstream): `WebSocketClient` enforces a configurable maximum message size (default 64 MiB, fragmentation-aware); `MqttConnection`'s
  keepalive doubles as a liveness watchdog (two silent intervals tear down the connection for reconnect).

## Keeping the shared library in sync

`src/lib` (excluding `ffmpeg/` and `index.ts`) is deliberately duplicated between
[homebridge-unifi-access](https://github.com/mp-consulting/homebridge-unifi-access) and
[homebridge-unifi-protect](https://github.com/mp-consulting/homebridge-unifi-protect) rather than shared through an npm package, to preserve the zero-dependency
posture. `scripts/check-lib-sync.sh` (run in CI as the `lib-sync` job) fails the build if the copies drift. When changing a shared file, apply the identical
change in the sibling repository.

## Syncing against upstream

Upstream fixes no longer arrive automatically. To review what changed upstream since the baseline:

1. Diff the upstream repository between the baseline version above and its current release (e.g. `git log v4.29.0..HEAD` in hjdhjd/unifi-protect).
2. Port relevant changes by hand, honoring the deviations listed above.
3. `npm run monitor:events` watches the live controller event stream for schema drift that may indicate API changes worth investigating upstream.
4. Update the baseline table and deviations in this document afterward.
