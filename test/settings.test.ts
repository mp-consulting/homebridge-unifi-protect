/* Copyright(C) 2022-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * settings.test.ts: Unit tests for settings and constants in settings.ts.
 */
import {
  PLUGIN_NAME,
  PLATFORM_NAME,
  PROTECT_CONTROLLER_REFRESH_INTERVAL,
  PROTECT_CONTROLLER_RETRY_INTERVAL,
  PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL,
  PROTECT_DOORBELL_AUTHSENSOR_DURATION,
  PROTECT_DOORBELL_CHIME_DURATION_DIGITAL,
  PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL,
  PROTECT_DOORBELL_CHIME_SPEAKER_DURATION,
  PROTECT_DOORBELL_MESSAGE_DURATION,
  PROTECT_DOORBELL_TRIGGER_DURATION,
  PROTECT_FFMPEG_AUDIO_FILTER_FFTNR,
  PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
  PROTECT_FFMPEG_PROBESIZE,
  PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD,
  PROTECT_FFMPEG_PROBESIZE_MAX,
  PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT,
  PROTECT_FFMPEG_PROBESIZE_PACKAGE,
  PROTECT_LIVESTREAM_API_IDR_INTERVAL,
  PROTECT_LIVESTREAM_RESTART_INTERVAL,
  PROTECT_LIVESTREAM_TIMEOUT,
  PROTECT_SEGMENT_RESOLUTION,
  PROTECT_HKSV_TIMEOUT,
  PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION,
  PROTECT_M3U_PLAYLIST_PORT,
  PROTECT_MOTION_DURATION,
  PROTECT_OCCUPANCY_DURATION,
  PROTECT_RPI_GPU_MINIMUM,
  PROTECT_SNAPSHOT_CACHE_MAXAGE,
  PROTECT_SNAPSHOT_TIMEOUT,
  PROTECT_TRANSCODE_BITRATE,
  PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE,
  PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO,
} from '../src/settings.js';

describe('settings', () => {

  describe('plugin identity', () => {

    it('PLUGIN_NAME equals "homebridge-unifi-protect"', () => {

      expect(PLUGIN_NAME).toBe('homebridge-unifi-protect');
    });

    it('PLATFORM_NAME equals "UniFi Protect"', () => {

      expect(PLATFORM_NAME).toBe('UniFi Protect');
    });
  });

  describe('duration constants are positive numbers', () => {

    const durationConstants: Record<string, number> = {
      PROTECT_CONTROLLER_REFRESH_INTERVAL,
      PROTECT_CONTROLLER_RETRY_INTERVAL,
      PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL,
      PROTECT_DOORBELL_AUTHSENSOR_DURATION,
      PROTECT_DOORBELL_CHIME_DURATION_DIGITAL,
      PROTECT_DOORBELL_CHIME_DURATION_MECHANICAL,
      PROTECT_DOORBELL_CHIME_SPEAKER_DURATION,
      PROTECT_DOORBELL_MESSAGE_DURATION,
      PROTECT_DOORBELL_TRIGGER_DURATION,
      PROTECT_FFMPEG_AUDIO_FILTER_FFTNR,
      PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
      PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
      PROTECT_FFMPEG_PROBESIZE,
      PROTECT_FFMPEG_PROBESIZE_ADJUSTMENT_THRESHOLD,
      PROTECT_FFMPEG_PROBESIZE_MAX,
      PROTECT_FFMPEG_PROBESIZE_OVERRIDE_TIMEOUT,
      PROTECT_FFMPEG_PROBESIZE_PACKAGE,
      PROTECT_LIVESTREAM_API_IDR_INTERVAL,
      PROTECT_LIVESTREAM_RESTART_INTERVAL,
      PROTECT_LIVESTREAM_TIMEOUT,
      PROTECT_SEGMENT_RESOLUTION,
      PROTECT_HKSV_TIMEOUT,
      PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION,
      PROTECT_MOTION_DURATION,
      PROTECT_OCCUPANCY_DURATION,
      PROTECT_RPI_GPU_MINIMUM,
      PROTECT_SNAPSHOT_CACHE_MAXAGE,
      PROTECT_SNAPSHOT_TIMEOUT,
      PROTECT_TRANSCODE_BITRATE,
      PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE,
    };

    it.each(Object.entries(durationConstants))('%s is a positive number', (_name, value) => {

      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    });
  });

  describe('HomeKit timeout constraints', () => {

    it('PROTECT_HKSV_TIMEOUT is less than 5000ms (HomeKit 5s threshold)', () => {

      expect(PROTECT_HKSV_TIMEOUT).toBeLessThan(5000);
    });

    it('PROTECT_SNAPSHOT_TIMEOUT is less than 5000ms (HomeKit 5s threshold)', () => {

      expect(PROTECT_SNAPSHOT_TIMEOUT).toBeLessThan(5000);
    });
  });

  describe('derived constants', () => {

    it('PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION equals PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2', () => {

      expect(PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION).toBe(PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2);
    });
  });

  describe('probesize hierarchy', () => {

    it('PROTECT_FFMPEG_PROBESIZE is less than PROTECT_FFMPEG_PROBESIZE_PACKAGE', () => {

      expect(PROTECT_FFMPEG_PROBESIZE).toBeLessThan(PROTECT_FFMPEG_PROBESIZE_PACKAGE);
    });

    it('PROTECT_FFMPEG_PROBESIZE_PACKAGE is less than PROTECT_FFMPEG_PROBESIZE_MAX', () => {

      expect(PROTECT_FFMPEG_PROBESIZE_PACKAGE).toBeLessThan(PROTECT_FFMPEG_PROBESIZE_MAX);
    });
  });

  describe('port numbers are valid', () => {

    it('PROTECT_M3U_PLAYLIST_PORT is a valid port number (> 0 and < 65536)', () => {

      expect(PROTECT_M3U_PLAYLIST_PORT).toBeGreaterThan(0);
      expect(PROTECT_M3U_PLAYLIST_PORT).toBeLessThan(65536);
    });
  });

  describe('PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO', () => {

    it('is a positive number greater than or equal to 1', () => {

      expect(typeof PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO).toBe('number');
      expect(PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO).toBeGreaterThanOrEqual(1);
    });

    it('at 2x, a 720p request allows 1440p but rejects 4K', () => {

      const ratio = PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO;
      const maxPixels = (1280 * ratio) * (720 * ratio);

      // 1080p (1920x1080 = 2,073,600) should fit.
      expect(1920 * 1080).toBeLessThanOrEqual(maxPixels);

      // 4K (3840x2160 = 8,294,400) should be rejected.
      expect(3840 * 2160).toBeGreaterThan(maxPixels);
    });

    it('at 2x, a 1080p request allows up to 4K', () => {

      const ratio = PROTECT_TRANSCODE_MAX_DOWNSCALE_RATIO;
      const maxPixels = (1920 * ratio) * (1080 * ratio);

      // 4K (3840x2160 = 8,294,400) should fit exactly.
      expect(3840 * 2160).toBeLessThanOrEqual(maxPixels);
    });
  });
});
