# UniFi Protect Realtime Events API

This document describes the realtime event protocol used by UniFi Protect controllers and how the homebridge-unifi-protect plugin processes them.

## Protocol Overview

Protect controllers stream updates over a WebSocket connection using a binary protocol. Each message is decoded into a **packet** with two components:

```
┌────────────────┐
│  Header Frame  │  8 bytes overhead
├────────────────┤
│  Action Frame  │  JSON — identifies the event
├────────────────┤
│  Header Frame  │  8 bytes overhead
├────────────────┤
│  Data Frame    │  JSON — the event payload
└────────────────┘
```

After decoding, each packet is represented as:

```typescript
interface ProtectEventPacket {
  header: ProtectEventHeader;
  payload: unknown;
}

interface ProtectEventHeader {
  action: string;        // "add", "update", or "remove"
  id: string;            // Device or event ID
  modelKey: string;      // Device category or "event"
  newUpdateId: string;   // Per-update UUID
  // Optional extras:
  _body?: object;        // Internal body reference
  _isEvent?: boolean;    // Whether this is an event-type packet
  mac?: string;          // Device MAC address
  modifiedKeys?: string[]; // Keys modified in this update
  nvrMac?: string;       // NVR MAC address
  recordId?: string;     // Associated event record ID
  recordModel?: string;  // Associated event record model
  state?: string;        // Device connection state
  token?: object;        // Authentication token
}
```

## Actions

| Action   | Description                                                                 |
|----------|-----------------------------------------------------------------------------|
| `add`    | New event created (motion, ring, smart detection, device adoption, etc.)    |
| `update` | Device state or event updated (partial JSON patch of the device config)     |
| `remove` | Event or device removed                                                     |

## Event Types (action:modelKey)

Events are identified by the combination of `header.action` and `header.modelKey`.

### Add Events

These signal the start of a new event item in the Protect events list.

#### `add:event`

New event item. The payload is a `ProtectEventAdd` object, but its shape varies by `payload.type`:

**Common fields (all sub-types):**

| Field      | Type    | Description                         |
|------------|---------|-------------------------------------|
| `id`       | string  | Unique event ID                     |
| `locked`   | boolean | Whether the event is locked         |
| `modelKey` | string  | Always `"event"`                    |
| `score`    | number  | Confidence score (0 initially)      |
| `start`    | number  | Event start timestamp (ms)          |
| `type`     | string  | Event sub-type (see table below)    |
| `user`     | string  | User ID associated with the event   |

**Additional fields on motion/detection events:**

| Field              | Type     | Description                              |
|--------------------|----------|------------------------------------------|
| `camera`           | string   | Camera ID (alternate field)              |
| `cameraId`         | string   | Camera ID                                |
| `detectedAt`       | number   | Detection timestamp                      |
| `end`              | number   | Event end timestamp (0 while ongoing)    |
| `eventId`          | string   | Related event chain ID                   |
| `metadata`         | object   | Detection metadata (see below)           |
| `partition`        | string   | Storage partition                        |
| `smartDetectEvents`| array    | Related smart detection event IDs        |
| `smartDetectTypes` | array    | Detected object types (person, vehicle…) |
| `thumbnailId`      | string   | Thumbnail image ID                       |

**Additional fields on app/user action events:**

| Field              | Type   | Description                     |
|--------------------|--------|---------------------------------|
| `device`           | object | Device reference                |
| `favoriteObjectIds`| object | Favorited object IDs            |
| `isFavorite`       | object | Favorite state                  |

**Event sub-types (`payload.type`):**

| Type                   | Used by Plugin | Description                                    |
|------------------------|:--------------:|------------------------------------------------|
| `motion`               | —              | Basic motion (plugin uses `lastMotion` instead)|
| `ring`                 | —              | Doorbell ring (plugin uses `lastRing` instead) |
| `smartDetectZone`      | yes            | Smart detection in a zone                      |
| `smartDetectLine`      | yes            | Smart detection crossing a line                |
| `smartDetectTamper`    | yes            | Camera tamper detected                         |
| `deviceAdopted`        | yes            | Device adopted to controller                   |
| `deviceUnadopted`      | yes            | Device removed from controller                 |
| `fingerprintIdentified`| yes            | Fingerprint recognized (doorbell)              |
| `nfcCardScanned`       | yes            | NFC card scanned (doorbell)                    |
| `access`               | yes            | Access unlock event (via metadata.action)      |
| `sensorOpened`         | —              | Sensor opened                                  |
| `sensorClosed`         | —              | Sensor closed                                  |
| *(app audit types)*    | —              | Favorites, user logins — ignored by plugin     |

#### `add:smartDetectObject`

Smart detection object identified. Uses the same payload schema as `add:event` but routed via a dedicated modelKey for smart detections. The `payload.type` contains the detected object class (e.g. `"person"`, `"vehicle"`, `"animal"`).

**Plugin handler:** `protect-camera.ts` `addEventHandler()` — triggers `motionEventHandler()` with the object type.

### Update Events

These deliver partial JSON patches to device configurations. The payload is a subset of the device's bootstrap config — only changed fields are included.

#### `update:camera`

Partial update to a camera's configuration. Key fields the plugin watches:

| Payload Field         | Plugin Action                                   |
|-----------------------|-------------------------------------------------|
| `lastMotion`          | Triggers motion event in HomeKit                |
| `lastRing`            | Triggers doorbell ring event in HomeKit         |
| `isConnected`         | Updates StatusActive characteristic             |
| `name`                | Syncs device name to HomeKit (if enabled)       |
| `channels`            | Updates RTSP stream configuration               |
| `smartDetectSettings` | Updates smart detection configuration           |

#### `update:nvr`

Partial update to the NVR configuration. Common payload keys observed:

- `uptime`, `lastSeen` — periodic heartbeat
- `systemInfo` — CPU, memory, temperature stats
- `wanPorts`, `portStatus` — network status
- `storageStats` — disk usage

#### `update:event`

Update to an in-progress event (e.g. confidence score finalized, event ended):

| Field              | Type    | Description                             |
|--------------------|---------|-----------------------------------------|
| `end`              | number  | Event end timestamp                     |
| `score`            | number  | Final confidence score                  |
| `locked`           | boolean | Lock state                              |
| `metadata`         | object  | Updated detection metadata              |
| `smartDetectEvents`| array   | Updated smart detection event IDs       |
| `smartDetectTypes` | array   | Updated detected object types           |
| `thumbnailId`      | string  | Updated thumbnail ID                    |
| `type`             | string  | Event type                              |

#### `update:light`

Partial update to a light device. The plugin watches `lastMotion` for motion events and light state for HomeKit sync.

#### `update:sensor`

Partial update to a sensor device. Processes sensor state changes (open/close, temperature, humidity, etc.).

#### `update:chime`

Partial update to a chime device configuration.

#### `update:bridge`

Partial update to a bridge device. Observed on controllers with Protect bridges.

#### `update:user`

User account update. Contains permissions, login info. Not used by the plugin.

#### `update:automation`

Automation rule state update. Contains `status` and `cooldown` fields. Not used by the plugin.

#### `update:viewer`

Partial update to a viewport device configuration.

### Remove Events

#### `remove:event`

Event removed from the Protect events list. The plugin emits this but does not actively process it.

## Metadata Schema

The `metadata` object in `add:event` payloads carries detection details:

| Field               | Type    | Description                                    |
|---------------------|---------|------------------------------------------------|
| `detectedThumbnails`| array   | Array of detected object thumbnails            |
| `detectedAreas`     | array   | Areas where detection occurred                 |
| `action`            | string  | Access action (e.g. `"open_door"`)             |
| `deviceId`          | object  | `{ text: "device-id" }` — for adoption events |
| `fingerprint`       | object  | `{ ulpId: "..." }` — fingerprint data          |
| `nfc`               | object  | `{ nfcId: "...", ulpId: "..." }` — NFC data    |
| `licensePlate`      | object  | `{ name: "...", confidenceLevel: N }`          |
| `userName`          | string  | User name (app audit events)                   |
| `clientPlatform`    | string  | Client platform (app audit events)             |
| `ip`                | string  | Client IP (app audit events)                   |

### Detected Thumbnail Schema

Each element in `metadata.detectedThumbnails`:

| Field          | Type   | Description                                       |
|----------------|--------|---------------------------------------------------|
| `type`         | string | Object type (`"person"`, `"vehicle"`, `"animal"`)  |
| `confidence`   | number | Detection confidence percentage                   |
| `name`         | string | Identified name (e.g. license plate text)          |
| `coord`        | array  | Bounding box `[x, y, width, height]`               |
| `objectId`     | string | Unique object tracking ID                          |
| `croppedId`    | string | Cropped thumbnail ID                               |
| `clockBestWall`| number | Best-frame wall clock timestamp                    |
| `attributes`   | object | Additional attributes (see below)                  |

### Thumbnail Attributes

| Attribute     | Structure                          | Description               |
|---------------|-------------------------------------|---------------------------|
| `color`       | `{ val: string, confidence: N }`   | Vehicle color             |
| `vehicleType` | `{ val: string, confidence: N }`   | Vehicle type              |
| `faceMask`    | `{ val: string, confidence: N }`   | Face mask detection       |
| `trackerId`   | `string`                            | Object tracker ID         |
| `zone`        | `number[]`                          | Detection zone indices    |

## Plugin Event Flow

```
WebSocket → ProtectApi.on('message') → ProtectEvents.configureEvents()
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
               add action              update action             remove action
                    │                         │                         │
         ┌──────────┤              ┌──────────┤                   emit removeEvent
         │          │              │          │
    emit addEvent   │      emit updateEvent   │
    emit addEvent.  │      emit updateEvent.  │
      {cameraId}    │        {deviceId}       │
    emit addEvent.  │      emit updateEvent.  │
      {modelKey}    │        {modelKey}       │
                    │                         │
         ┌──────────┘              ┌──────────┘
         │                         │
    manageDevices()           ufpUpdates()
    (deviceAdopted/           (deep merge payload
     deviceUnadopted)          into device config)
         │                         │
    Per-device handlers:      Per-device handlers:
    ├─ addEventHandler()      ├─ eventHandler() [camera]
    │  ├─ Access unlock       │  ├─ lastMotion → motion event
    │  ├─ Tamper detect       │  ├─ lastRing → doorbell ring
    │  ├─ Smart detection     │  ├─ smart detect settings
    │  └─ Fingerprint/NFC     │  └─ name sync, RTSP update
    └─ [doorbell override]    ├─ eventHandler() [light]
       ├─ fingerprintIdent.   │  └─ lastMotion, light state
       └─ nfcCardScanned      └─ eventHandler() [sensor]
                                  └─ sensor state changes
```

## Schema Monitoring

Use `npm run monitor:events` to validate live events against known schemas:

```bash
npm run monitor:events                          # uses test/hbConfig/config.json
npm run monitor:events -- --dump                # also saves raw events to tmp/events/
npm run monitor:events -- --address 192.168.1.1 --username admin --password pass
```

Schema definitions live in `test/event-schemas.ts` and are the single source of truth for both live monitoring and static tests.

## Tips for Working with Protect Events

- **Motion detection**: Don't rely on `add:event` with `type: "motion"` — it's slow. Watch `update:camera` for `lastMotion` changes instead.
- **Doorbell rings**: Same principle — watch `update:camera` for `lastRing` changes.
- **Smart detection**: Use `add:event` / `add:smartDetectObject` for real-time smart detections with object classification.
- **Partial updates**: `update:*` payloads are always partial. Only changed fields are included — never assume a field will be present.
- **Bootstrap refresh**: The plugin periodically re-bootstraps by emitting synthetic `update` events with `header.hbupBootstrap: true` containing the full device config.
