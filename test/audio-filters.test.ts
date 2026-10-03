/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * audio-filters.test.ts: Tests for the FFmpeg audio filter pipeline exposed by ProtectCamera.audioFilters.
 *
 * The audioFilters getter constructs a list of FFmpeg audio filter expressions for noise reduction, with optional highpass and lowpass filters, driven by
 * the camera's feature options. It clamps the fftNr parameter to valid FFmpeg ranges.
 */
import { describe, expect, it } from 'vitest';
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR } from '../src/settings.js';
import { ProtectCamera } from '../src/devices/protect-camera.js';

// The feature option values our fake camera reports. A missing value means the option isn't set.
interface FilterOptions {

  enabled?: boolean;
  fftNr?: number;
  highpass?: number;
  lowpass?: number;
}

// The real audioFilters getter from ProtectCamera.
const audioFiltersGetter = Object.getOwnPropertyDescriptor(ProtectCamera.prototype, 'audioFilters')?.get as (this: unknown) => string[];

// Evaluate the real ProtectCamera.audioFilters getter against a camera whose feature options are configured as requested.
function audioFilters(options: FilterOptions): string[] {

  const camera = {

    getFeatureFloat: (option: string): number | null => (option === 'Audio.Filter.Noise.FftNr') ? (options.fftNr ?? null) : null,
    getFeatureNumber: (option: string): number | null => {

      switch(option) {

        case 'Audio.Filter.Noise.HighPass':

          return options.highpass ?? null;

        case 'Audio.Filter.Noise.LowPass':

          return options.lowpass ?? null;

        default:

          return null;
      }
    },
    hasFeature: (option: string): boolean => (option === 'Audio.Filter.Noise') && (options.enabled ?? true),
  };

  return audioFiltersGetter.call(camera);
}

// Shorthand for the afftdn filter expression with a given noise reduction value.
const afftdn = (nr: string): string => "asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=" + nr;

describe('ProtectCamera.audioFilters', () => {

  it('returns no filters when noise filtering is disabled', () => {

    expect(audioFilters({ enabled: false, fftNr: 20, highpass: 150, lowpass: 9000 })).toEqual([]);
  });

  describe('fftNr only (no optional filters)', () => {

    it('returns a single afftdn filter with the requested noise reduction and noise profile training commands', () => {

      expect(audioFilters({ fftNr: 14 })).toEqual([ afftdn('14') ]);
    });

    it('falls back to the default noise reduction when none is configured', () => {

      expect(audioFilters({})).toEqual([ afftdn(PROTECT_FFMPEG_AUDIO_FILTER_FFTNR.toString()) ]);
    });
  });

  describe('optional highpass filter', () => {

    it('prepends highpass filter before afftdn', () => {

      expect(audioFilters({ fftNr: 14, highpass: 150 })).toEqual([ 'highpass=p=2:f=150', afftdn('14') ]);
    });

    it('includes highpass at 0', () => {

      expect(audioFilters({ fftNr: 14, highpass: 0 })).toEqual([ 'highpass=p=2:f=0', afftdn('14') ]);
    });
  });

  describe('optional lowpass filter', () => {

    it('prepends lowpass filter before afftdn', () => {

      expect(audioFilters({ fftNr: 14, lowpass: 9000 })).toEqual([ 'lowpass=p=2:f=9000', afftdn('14') ]);
    });

    it('includes lowpass at 0', () => {

      expect(audioFilters({ fftNr: 14, lowpass: 0 })).toEqual([ 'lowpass=p=2:f=0', afftdn('14') ]);
    });
  });

  describe('both highpass and lowpass', () => {

    it('includes all three filters in order: highpass, lowpass, afftdn', () => {

      expect(audioFilters({ fftNr: 14, highpass: 150, lowpass: 9000 })).toEqual([ 'highpass=p=2:f=150', 'lowpass=p=2:f=9000', afftdn('14') ]);
    });
  });

  describe('fftNr clamping', () => {

    it.each([

      [ -10, '0.01' ],
      [ 0, '0.01' ],
      [ 0.01, '0.01' ],
      [ 50, '50' ],
      [ 97, '97' ],
      [ 200, '97' ],
    ])('maps fftNr %s to nr=%s', (fftNr, expected) => {

      expect(audioFilters({ fftNr })).toEqual([ afftdn(expected) ]);
    });
  });
});
