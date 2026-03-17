/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-protect.
 */
// The name of our plugin.
export const PLUGIN_NAME = 'homebridge-unifi-protect';

// The platform the plugin creates.
export const PLATFORM_NAME = 'UniFi Protect';

// How often, in seconds, should we check Protect controllers for new or removed devices.
export const PROTECT_CONTROLLER_REFRESH_INTERVAL = 120;

// How often, in seconds, should we retry getting our bootstrap configuration from the Protect controller.
export const PROTECT_CONTROLLER_RETRY_INTERVAL = 10;

// Default delay, in seconds, before removing Protect devices that no longer exist.
export const PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL = 60;

// Default duration, in milliseconds, of the authentication contact sensor for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_AUTHSENSOR_DURATION = 5000;

// Default duration, in milliseconds, of a physical digital chime attached to a Protect doorbell. This value comes from UniFi Protect itself.
export const PROTECT_DOORBELL_CHIME_DURATION_DIGITAL = 1000;

// Default duration, in milliseconds, of a physical mechanical chime attached to a Protect doorbell. This value comes from UniFi Protect itself.
export const PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL = 300;

// Default duration, in milliseconds, to wait before allowing another trigger of the buzzer or speaker on the chime.
export const PROTECT_DOORBELL_CHIME_SPEAKER_DURATION = 3500;

// Default duration, in milliseconds, of a doorbell LCD message before it resets.
export const PROTECT_DOORBELL_MESSAGE_DURATION = 60000;

// Default duration, in milliseconds, of the trigger switch for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_TRIGGER_DURATION = 5000;

// Default FFmpeg probesize, in bytes, for standard cameras. Balances latency vs. reliable stream detection.
export const PROTECT_FFMPEG_PROBESIZE = 16384;

// Default FFmpeg probesize, in bytes, for package cameras. Larger because the secondary camera stream needs more analysis.
export const PROTECT_FFMPEG_PROBESIZE_PACKAGE = 32768;

// Maximum FFmpeg probesize, in bytes, after automatic adjustments. Safety cap to prevent unbounded growth.
export const PROTECT_FFMPEG_PROBESIZE_MAX = 5000000;

// Number of consecutive probesize adjustments before making the override permanent instead of temporary.
export const PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD = 10;

// Duration, in milliseconds, before a temporary probesize override resets back to the default (10 minutes).
export const PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT = 600000;

// FFmpeg afftdn audio filter defaults - this setting uses FFTs to reduce noise in an audio signal by the number of decibels below.
export const PROTECT_FFMPEG_AUDIO_FILTER_FFTNR = 14;

// FFmpeg highpass audio filter defaults - this setting attenuates (eliminates) frequencies below the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS = 150;

// FFmpeg lowpass audio filter defaults - this setting attenuates (eliminates) frequencies above the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS = 9000;

// Protect's native I-frame interval can vary, but the livestream API seems to default to 5 seconds at most, though it depends on camera type and stream
// quality selected.
export const PROTECT_LIVESTREAM_API_IDR_INTERVAL = 5;

// Default restart interval, in seconds, for the livestream API. This is used as the base backoff interval when reconnecting.
export const PROTECT_LIVESTREAM_RESTART_INTERVAL = 10;

// Default timeout, in milliseconds, before considering a livestream API session as stale and triggering a restart.
export const PROTECT_LIVESTREAM_TIMEOUT = 3500;

// Default retry interval, in milliseconds, for the livestream API when the controller is offline or throttled.
export const PROTECT_LIVESTREAM_OFFLINE_RETRY_INTERVAL = 60000;

// Protect fMP4 segment resolution, in milliseconds. This defines the resolution of our buffer. It should never be less than 100ms or greater than 1500ms.
export const PROTECT_SEGMENT_RESOLUTION = 100;

// HomeKit Secure Video communication timeout threshold, in milliseconds. HKSV has a strict 5 second threshold for communication, so we set this a
// little below that.
export const PROTECT_HKSV_TIMEOUT = 4500;

// HomeKit Secure Video timeshift buffer default duration, in milliseconds. This defines how far back in time we can look when we see a motion event.
export const PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2;

// Default port to use to publish an M3U playlist for use in other apps that can consume one to make camera livestreams available, such as Channels DVR.
export const PROTECT_M3U_PLAYLIST_PORT = 10110;

// Default duration, in seconds, of motion events. Setting this too low will potentially cause a lot of notification spam.
export const PROTECT_MOTION_DURATION = 10;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/protect/camera/event
export const PROTECT_MQTT_TOPIC = 'unifi/protect';

// Default duration, in seconds, of occupancy events.
export const PROTECT_OCCUPANCY_DURATION = 300;

// Minimum required GPU memory on a Raspberry Pi for hardware acceleration.
export const PROTECT_RPI_GPU_MINIMUM = 128;

// Maximum age of a snapshot in seconds.
export const PROTECT_SNAPSHOT_CACHE_MAXAGE = 90;

// Snapshot retrieval timeout, in milliseconds. HomeKit has a strict 5 second threshold for communication, so we set this just below that.
export const PROTECT_SNAPSHOT_TIMEOUT = 4990;

// Maximum downscale ratio (per dimension) allowed when selecting a source stream for transcoding. Streams requiring a larger downscale are filtered out
// before selection. For example, a ratio of 2 means a 720p request allows up to ~1440p input (2x), but rejects 4K (3x). This prevents overwhelming the
// hardware transcoder with an excessively large resolution gap.
export const PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO = 2;

// Bitrate, in kilobits per second, to use when transcoding to local clients.
export const PROTECT_TRANSCODE_BITRATE = 2000;

// Bitrate, in kilobits per second, to use when transcoding to high-latency clients.
export const PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE = 1000;

// Polling interval, in milliseconds, for ambient light sensor updates.
export const PROTECT_AMBIENT_LIGHT_POLL_INTERVAL = 60000;

// Delay, in milliseconds, for deferred HomeKit characteristic updates. This brief delay ensures characteristic changes propagate correctly to HomeKit
// controllers when responding to user-initiated set operations.
export const PROTECT_HOMEKIT_UPDATE_DELAY = 50;

// Minimum ambient light level that HomeKit will accept, in lux.
export const HOMEKIT_AMBIENT_LIGHT_MINIMUM = 0.0001;

// Plugin logo URL for M3U playlist guide information.
export const PROTECT_PLAYLIST_LOGO_URL =
  'https://raw.githubusercontent.com/mp-consulting/homebridge-unifi-protect/main/docs/media/homebridge-unifi-protect-4x3.png';
