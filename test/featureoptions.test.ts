/* Copyright(C) 2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * featureoptions.test.ts: Tests for the hierarchical FeatureOptions engine (src/lib/featureoptions.ts), driven by the plugin's real feature option catalog.
 */
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION } from '../src/settings.js';
import { describe, expect, it } from 'vitest';
import { featureOptionCategories, featureOptions } from '../src/protect-options.js';
import { FeatureOptions } from '../src/lib/featureoptions.js';

const CONTROLLER = '001122334455';
const DEVICE = 'AABBCC112233';
const OTHER_DEVICE = 'FFEEDDCCBBAA';

// A representative configuration spanning every scope, value-centric options, and disabled value options.
const CONFIGURED = [

  'Disable.Device',
  'Enable.Device.AABBCC112233',
  'Enable.Video.HKSV.Recording.Switch.001122334455',
  'Disable.Video.HKSV.Recording.Switch.AABBCC112233',
  'Enable.Log.Motion',
  'Disable.Log.Motion.001122334455',
  'Enable.Log.Motion.AABBCC112233',
  'Enable.Motion.Duration.42',
  'Enable.Motion.Duration.AABBCC112233.7',
  'Enable.Motion.OccupancySensor.Duration.abc',
  'Disable.Video.Transcode.Bitrate',
  'Enable.Doorbell.PhysicalChime.Duration.Digital.001122334455.2500',
  'Enable.Audio.Filter.Noise.FftNr.AABBCC112233.18',
  'Enable.Audio.Filter.Noise.FftNr.FFEEDDCCBBAA.loud',
];

const makeOptions = (configured: string[] = CONFIGURED): FeatureOptions => new FeatureOptions(featureOptionCategories, featureOptions, configured);

describe('FeatureOptions defaults', () => {

  const options = makeOptions([]);

  it('returns the catalog default for unconfigured options', () => {

    expect(options.test('Device')).toBe(true);
    expect(options.test('Device.SyncName')).toBe(false);
    expect(options.defaultValue('Device')).toBe(true);
    expect(options.defaultValue('Device.SyncName')).toBe(false);
  });

  it('returns defaultReturnValue for options unknown to the catalog', () => {

    expect(options.test('Not.A.Real.Option')).toBe(false);

    options.defaultReturnValue = true;

    expect(options.test('Not.A.Real.Option')).toBe(true);

    options.defaultReturnValue = false;
  });

  it('reports scope "none" for unconfigured options', () => {

    expect(options.scope('Device', DEVICE, CONTROLLER)).toBe('none');
    expect(options.color('Device', DEVICE, CONTROLLER)).toBe('');
  });

  it('falls back to the registered default value for unconfigured value options', () => {

    expect(options.value('Motion.Duration')).toBe(PROTECT_MOTION_DURATION.toString());
    expect(options.getInteger('Motion.Duration', DEVICE, CONTROLLER)).toBe(PROTECT_MOTION_DURATION);
    expect(options.getFloat('Audio.Filter.Noise.FftNr')).toBe(PROTECT_FFMPEG_AUDIO_FILTER_FFTNR);
  });

  it('returns null for a value option whose default is disabled', () => {

    // The license plate option defaults to disabled, so it has no value until enabled.
    expect(options.value('Motion.SmartDetect.ObjectSensors.LicensePlate')).toBeNull();
    expect(options.getInteger('Nvr.Service.Playlist')).toBeNull();
  });

  it('returns null from value() for options that are not value-centric', () => {

    expect(options.isValue('Device')).toBe(false);
    expect(options.isValue('')).toBe(false);
    expect(options.value('Device')).toBeNull();
  });
});

describe('FeatureOptions scope precedence', () => {

  const options = makeOptions();

  it('a device setting overrides a global setting', () => {

    expect(options.test('Device')).toBe(false);
    expect(options.test('Device', OTHER_DEVICE, CONTROLLER)).toBe(false);
    expect(options.test('Device', DEVICE, CONTROLLER)).toBe(true);
  });

  it('a device setting overrides a controller setting', () => {

    expect(options.test('Video.HKSV.Recording.Switch', OTHER_DEVICE, CONTROLLER)).toBe(true);
    expect(options.test('Video.HKSV.Recording.Switch', DEVICE, CONTROLLER)).toBe(false);
  });

  it('a controller setting overrides a global setting, and a device setting overrides both', () => {

    expect(options.test('Log.Motion')).toBe(true);
    expect(options.test('Log.Motion', OTHER_DEVICE)).toBe(true);
    expect(options.test('Log.Motion', OTHER_DEVICE, CONTROLLER)).toBe(false);
    expect(options.test('Log.Motion', DEVICE, CONTROLLER)).toBe(true);
  });

  it('does not apply a controller setting when no controller is supplied', () => {

    expect(options.test('Video.HKSV.Recording.Switch', OTHER_DEVICE)).toBe(false);
  });

  it('reports the scope each option resolved at', () => {

    expect(options.scope('Device', DEVICE, CONTROLLER)).toBe('device');
    expect(options.scope('Device', OTHER_DEVICE, CONTROLLER)).toBe('global');
    expect(options.scope('Video.HKSV.Recording.Switch', OTHER_DEVICE, CONTROLLER)).toBe('controller');
    expect(options.scope('Video.HKSV.Recording.Switch', DEVICE, CONTROLLER)).toBe('device');
    expect(options.scope('Device.SyncName', DEVICE, CONTROLLER)).toBe('none');
  });

  it('maps scopes to UI colors', () => {

    expect(options.color('Device', DEVICE, CONTROLLER)).toBe('text-info');
    expect(options.color('Video.HKSV.Recording.Switch', OTHER_DEVICE, CONTROLLER)).toBe('text-success');
    expect(options.color('Device', OTHER_DEVICE)).toBe('text-warning');
    expect(options.color('Device')).toBe('text-info');
  });

  it('reports explicit existence at global and device scope', () => {

    expect(options.isScopeGlobal('Device')).toBe(true);
    expect(options.isScopeGlobal('Device.SyncName')).toBe(false);
    expect(options.isScopeDevice('Device', DEVICE)).toBe(true);
    expect(options.isScopeDevice('Device', OTHER_DEVICE)).toBe(false);
  });

  it('honors the first entry when an option is configured more than once', () => {

    const duplicated = makeOptions([ 'Enable.Device.SyncName', 'Disable.Device.SyncName' ]);

    expect(duplicated.test('Device.SyncName')).toBe(true);
  });

  it('ignores entries that are not Enable or Disable actions', () => {

    const malformed = makeOptions([ 'Toggle.Device.SyncName', 'Enable' ]);

    expect(malformed.test('Device.SyncName')).toBe(false);
    expect(malformed.scope('Device.SyncName')).toBe('none');
  });
});

describe('FeatureOptions case-insensitive matching', () => {

  const options = makeOptions();

  it('matches device and controller MAC addresses regardless of case', () => {

    expect(options.test('Device', DEVICE.toLowerCase(), CONTROLLER)).toBe(true);
    expect(options.test('Video.HKSV.Recording.Switch', OTHER_DEVICE.toLowerCase(), CONTROLLER.toLowerCase())).toBe(true);
    expect(options.getInteger('Motion.Duration', DEVICE.toLowerCase())).toBe(7);
  });

  it('matches option names regardless of case', () => {

    expect(options.test('device', DEVICE)).toBe(true);
    expect(options.test('VIDEO.HKSV.RECORDING.SWITCH', DEVICE, CONTROLLER)).toBe(false);
    expect(options.getInteger('motion.duration')).toBe(42);
  });

  it('matches mixed-case actions and option names in the configured list', () => {

    expect(makeOptions([ 'eNaBlE.device.syncname.aabbcc112233' ]).test('Device.SyncName', DEVICE)).toBe(true);
  });
});

describe('FeatureOptions value options', () => {

  const options = makeOptions();

  it('parses a global value', () => {

    expect(options.value('Motion.Duration')).toBe('42');
    expect(options.getInteger('Motion.Duration')).toBe(42);
    expect(options.getInteger('Motion.Duration', OTHER_DEVICE, CONTROLLER)).toBe(42);
  });

  it('parses a device-scoped value, which takes precedence over the global value', () => {

    expect(options.value('Motion.Duration', DEVICE, CONTROLLER)).toBe('7');
    expect(options.getInteger('Motion.Duration', DEVICE, CONTROLLER)).toBe(7);
  });

  it('parses a controller-scoped value', () => {

    expect(options.getInteger('Doorbell.PhysicalChime.Duration.Digital', OTHER_DEVICE, CONTROLLER)).toBe(2500);
    expect(options.scope('Doorbell.PhysicalChime.Duration.Digital', OTHER_DEVICE, CONTROLLER)).toBe('controller');
  });

  it('parses floating point values', () => {

    expect(options.getFloat('Audio.Filter.Noise.FftNr', DEVICE)).toBe(18);
  });

  it('returns undefined for values that are not numbers', () => {

    expect(options.value('Motion.OccupancySensor.Duration')).toBe('abc');
    expect(options.getInteger('Motion.OccupancySensor.Duration')).toBeUndefined();
    expect(options.getFloat('Audio.Filter.Noise.FftNr', OTHER_DEVICE)).toBeUndefined();
  });

  it('returns null for a value option that has been disabled', () => {

    expect(options.value('Video.Transcode.Bitrate')).toBeNull();
    expect(options.getInteger('Video.Transcode.Bitrate')).toBeNull();
    expect(options.getFloat('Video.Transcode.Bitrate')).toBeNull();
  });

  it('returns undefined for a value option that is enabled without a value', () => {

    const enabledOnly = makeOptions([ 'Enable.Motion.OccupancySensor.Duration' ]);

    expect(enabledOnly.value('Motion.OccupancySensor.Duration')).toBeUndefined();
    expect(enabledOnly.getInteger('Motion.OccupancySensor.Duration')).toBeUndefined();
  });

  it('falls back to the default value for options left unconfigured alongside configured ones', () => {

    expect(makeOptions([ 'Enable.Motion.Duration.42' ]).getInteger('Motion.OccupancySensor.Duration')).toBe(PROTECT_OCCUPANCY_DURATION);
  });

  it('preserves the original case of string values', () => {

    expect(makeOptions([ 'Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.AbC123' ]).value('Motion.SmartDetect.ObjectSensors.LicensePlate'))
      .toBe('AbC123');
  });
});

describe('FeatureOptions catalog bookkeeping', () => {

  const options = makeOptions();

  it('expands category and option names', () => {

    expect(options.expandOption('Device', '')).toBe('Device');
    expect(options.expandOption('Device', 'SyncName')).toBe('Device.SyncName');
    expect(options.expandOption('', 'SyncName')).toBe('');
    expect(options.expandOption({ description: 'Video', name: 'Video' }, { default: false, description: '', name: 'Crop' })).toBe('Video.Crop');
  });

  it('indexes option groups', () => {

    expect(options.groups['Audio.Filter.Noise']).toEqual([ 'Audio.Filter.Noise.FftNr', 'Audio.Filter.Noise.HighPass', 'Audio.Filter.Noise.LowPass' ]);
    expect(options.groups['Video.Crop']).toEqual([ 'Video.Crop.X', 'Video.Crop.Y', 'Video.Crop.Width', 'Video.Crop.Height' ]);
  });

  it('recognizes value-centric options from the catalog', () => {

    expect(options.isValue('Motion.Duration')).toBe(true);
    expect(options.isValue('Video.HKSV.Recording.Switch')).toBe(false);
  });

  it('rebuilds its index when the configured options change', () => {

    const mutable = makeOptions([]);

    expect(mutable.test('Device.SyncName', DEVICE)).toBe(false);

    mutable.configuredOptions = [ 'Enable.Device.SyncName.AABBCC112233' ];

    expect(mutable.configuredOptions).toEqual([ 'Enable.Device.SyncName.AABBCC112233' ]);
    expect(mutable.test('Device.SyncName', DEVICE)).toBe(true);
  });

  it('exposes its categories and options', () => {

    expect(options.categories).toBe(featureOptionCategories);
    expect(options.options).toBe(featureOptions);
  });
});

describe('FeatureOptions decimal values', () => {

  it('reads a global decimal value rather than treating its integer part as a scope id', () => {

    const decimal = makeOptions([ 'Enable.Audio.Filter.Noise.FftNr.12.5' ]);

    expect(decimal.getFloat('Audio.Filter.Noise.FftNr')).toBe(12.5);
    expect(decimal.getFloat('Audio.Filter.Noise.FftNr', DEVICE, CONTROLLER)).toBe(12.5);
  });

  it('reads a device-scoped decimal value', () => {

    const decimal = makeOptions([ 'Enable.Audio.Filter.Noise.FftNr.' + DEVICE + '.7.25' ]);

    expect(decimal.getFloat('Audio.Filter.Noise.FftNr', DEVICE)).toBe(7.25);
    expect(decimal.getFloat('Audio.Filter.Noise.FftNr')).toBe(PROTECT_FFMPEG_AUDIO_FILTER_FFTNR);
  });

  it('still reads a scope id followed by an integer value', () => {

    const scoped = makeOptions([ 'Enable.Audio.Filter.Noise.FftNr.' + CONTROLLER + '.5' ]);

    expect(scoped.getFloat('Audio.Filter.Noise.FftNr', DEVICE, CONTROLLER)).toBe(5);
    expect(scoped.getFloat('Audio.Filter.Noise.FftNr')).toBe(PROTECT_FFMPEG_AUDIO_FILTER_FFTNR);
  });

  it('defers to a caller-supplied identifier recognizer', () => {

    const recognizer = new FeatureOptions(featureOptionCategories, featureOptions, [ 'Enable.Audio.Filter.Noise.FftNr.12.5' ],
      { isIdentifier: (segment: string): boolean => segment === '12' });

    expect(recognizer.getFloat('Audio.Filter.Noise.FftNr', '12')).toBe(5);
    expect(recognizer.getFloat('Audio.Filter.Noise.FftNr')).toBe(PROTECT_FFMPEG_AUDIO_FILTER_FFTNR);
  });
});
