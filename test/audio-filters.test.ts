/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * audio-filters.test.ts: Tests for the FFmpeg audio filter pipeline builder from protect-camera.ts.
 *
 * The buildAudioFilterPipeline function constructs a list of FFmpeg audio filter expressions for noise
 * reduction, with optional highpass and lowpass filters. It clamps the fftNr parameter to valid FFmpeg ranges.
 */

// Reproduction of buildAudioFilterPipeline from protect-camera.ts.
function buildAudioFilterPipeline(fftNr: number, highpass?: number, lowpass?: number): string[] {

  const afOptions: string[] = [];

  // Clamp the noise reduction value to valid FFmpeg ranges.
  fftNr = Math.max(0.01, Math.min(97, fftNr));

  // Only set the highpass and lowpass filters if explicitly provided.
  if(typeof highpass === 'number') {

    afOptions.push('highpass=p=2:f=' + highpass.toString());
  }

  if(typeof lowpass === 'number') {

    afOptions.push('lowpass=p=2:f=' + lowpass.toString());
  }

  // The afftdn filter options: custom noise profile, noise tracking, and specified noise reduction.
  afOptions.push("asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=" + fftNr.toString());

  return afOptions;
}

describe('buildAudioFilterPipeline', () => {

  describe('fftNr only (no optional filters)', () => {

    it('returns a single afftdn filter string', () => {

      const result = buildAudioFilterPipeline(14);

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('afftdn');
    });

    it('includes the specified noise reduction value', () => {

      const result = buildAudioFilterPipeline(14);

      expect(result[0]).toContain('nr=14');
    });

    it('includes the noise profile training commands', () => {

      const result = buildAudioFilterPipeline(14);

      expect(result[0]).toContain('afftdn sn start');
      expect(result[0]).toContain('afftdn sn stop');
    });
  });

  describe('optional highpass filter', () => {

    it('prepends highpass filter before afftdn', () => {

      const result = buildAudioFilterPipeline(14, 150);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('highpass=p=2:f=150');
      expect(result[1]).toContain('afftdn');
    });

    it('includes highpass at 0 (typeof 0 is number)', () => {

      const result = buildAudioFilterPipeline(14, 0);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('highpass=p=2:f=0');
    });

    it('omits highpass when undefined', () => {

      const result = buildAudioFilterPipeline(14, undefined);

      expect(result).toHaveLength(1);
    });
  });

  describe('optional lowpass filter', () => {

    it('prepends lowpass filter before afftdn', () => {

      const result = buildAudioFilterPipeline(14, undefined, 9000);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('lowpass=p=2:f=9000');
      expect(result[1]).toContain('afftdn');
    });

    it('includes lowpass at 0', () => {

      const result = buildAudioFilterPipeline(14, undefined, 0);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('lowpass=p=2:f=0');
    });
  });

  describe('both highpass and lowpass', () => {

    it('includes all three filters in order: highpass, lowpass, afftdn', () => {

      const result = buildAudioFilterPipeline(14, 150, 9000);

      expect(result).toHaveLength(3);
      expect(result[0]).toBe('highpass=p=2:f=150');
      expect(result[1]).toBe('lowpass=p=2:f=9000');
      expect(result[2]).toContain('nr=14');
    });
  });

  describe('fftNr clamping', () => {

    it('clamps fftNr below minimum to 0.01', () => {

      const result = buildAudioFilterPipeline(-10);

      expect(result[0]).toContain('nr=0.01');
    });

    it('clamps fftNr of 0 to 0.01', () => {

      const result = buildAudioFilterPipeline(0);

      expect(result[0]).toContain('nr=0.01');
    });

    it('clamps fftNr above maximum to 97', () => {

      const result = buildAudioFilterPipeline(200);

      expect(result[0]).toContain('nr=97');
    });

    it('preserves fftNr at lower boundary (0.01)', () => {

      const result = buildAudioFilterPipeline(0.01);

      expect(result[0]).toContain('nr=0.01');
    });

    it('preserves fftNr at upper boundary (97)', () => {

      const result = buildAudioFilterPipeline(97);

      expect(result[0]).toContain('nr=97');
    });

    it('preserves valid fftNr within range', () => {

      const result = buildAudioFilterPipeline(50);

      expect(result[0]).toContain('nr=50');
    });
  });
});
