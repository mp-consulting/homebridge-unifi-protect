/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * resolution-generation.test.ts: Tests for resolution set generation and HKSV frame rate adjustment
 * from protect-camera-video.ts.
 *
 * The video delegate generates a set of HomeKit-compatible resolutions based on the camera's native aspect
 * ratio (4:3 or 16:9), and adjusts frame rates to meet HomeKit Secure Video requirements.
 */

// Reproduction of the aspect ratio detection from protect-camera-video.ts configure().
function getValidResolutions(nativeWidth: number, nativeHeight: number): number[][] {

  if((nativeWidth / nativeHeight) === (4 / 3)) {

    return [

      [3840, 2880], [2560, 1920],
      [1920, 1440], [1280, 960],
      [640, 480], [480, 360],
      [320, 240],
    ];
  }

  return [

    [3840, 2160], [2560, 1440],
    [1920, 1080], [1280, 720],
    [640, 360], [480, 270],
    [320, 180],
  ];
}

// Reproduction of the frame rate expansion: each resolution gets both 30fps and 15fps variants.
function expandWithFrameRates(resolutions: number[][]): number[][] {

  return resolutions.flatMap(([width, height]) => [30, 15].map(fps => [width, height, fps]));
}

// Reproduction of the HKSV frame rate adjustment from protect-camera-video.ts configure().
// Adjusts the first 1080p/1440p entry's fps to the nearest valid HomeKit fps if the camera's
// native frame rate doesn't match [15, 24, 30].
function adjustHksvFrameRate(fps: number): number {

  if(fps > 24) {

    return 30;
  }

  if(fps > 15) {

    return 24;
  }

  return 15;
}

// Reproduction of the resolution filtering logic: skip resolutions larger than the native resolution,
// except for 1920 and 1280 which HomeKit explicitly requires.
function shouldIncludeResolution(entryWidth: number, nativeWidth: number): boolean {

  if(entryWidth >= nativeWidth && ![1920, 1280].includes(entryWidth)) {

    return false;
  }

  return true;
}

describe('Aspect Ratio Detection', () => {

  describe('4:3 cameras', () => {

    it('detects 4:3 aspect ratio (1600x1200)', () => {

      const resolutions = getValidResolutions(1600, 1200);

      expect(resolutions[0]).toEqual([3840, 2880]);
      expect(resolutions[resolutions.length - 1]).toEqual([320, 240]);
    });

    it('detects 4:3 aspect ratio (2560x1920)', () => {

      const resolutions = getValidResolutions(2560, 1920);

      expect(resolutions).toContainEqual([1920, 1440]);
    });

    it('returns 7 resolution tiers for 4:3', () => {

      expect(getValidResolutions(1600, 1200)).toHaveLength(7);
    });

    it('all 4:3 resolutions maintain the 4:3 ratio', () => {

      for(const [width, height] of getValidResolutions(1600, 1200)) {

        expect(width / height).toBeCloseTo(4 / 3, 5);
      }
    });
  });

  describe('16:9 cameras', () => {

    it('detects 16:9 aspect ratio (1920x1080)', () => {

      const resolutions = getValidResolutions(1920, 1080);

      expect(resolutions[0]).toEqual([3840, 2160]);
      expect(resolutions[resolutions.length - 1]).toEqual([320, 180]);
    });

    it('returns 7 resolution tiers for 16:9', () => {

      expect(getValidResolutions(1920, 1080)).toHaveLength(7);
    });

    it('all 16:9 resolutions maintain the 16:9 ratio', () => {

      for(const [width, height] of getValidResolutions(1920, 1080)) {

        expect(width / height).toBeCloseTo(16 / 9, 5);
      }
    });
  });

  describe('non-standard aspect ratios fall through to 16:9', () => {

    it('uses 16:9 for 2:1 aspect ratio (3840x1920)', () => {

      const resolutions = getValidResolutions(3840, 1920);

      expect(resolutions[0]).toEqual([3840, 2160]);
    });

    it('uses 16:9 for 1:1 aspect ratio (1000x1000)', () => {

      const resolutions = getValidResolutions(1000, 1000);

      expect(resolutions[0]).toEqual([3840, 2160]);
    });
  });
});

describe('Frame Rate Expansion', () => {

  it('generates 30fps and 15fps for each resolution', () => {

    const expanded = expandWithFrameRates([[1920, 1080], [1280, 720]]);

    expect(expanded).toEqual([
      [1920, 1080, 30], [1920, 1080, 15],
      [1280, 720, 30], [1280, 720, 15],
    ]);
  });

  it('doubles the number of entries', () => {

    const base = getValidResolutions(1920, 1080);
    const expanded = expandWithFrameRates(base);

    expect(expanded).toHaveLength(base.length * 2);
  });
});

describe('HKSV Frame Rate Adjustment', () => {

  it('adjusts fps > 24 to 30', () => {

    expect(adjustHksvFrameRate(25)).toBe(30);
    expect(adjustHksvFrameRate(29)).toBe(30);
  });

  it('adjusts fps > 15 and <= 24 to 24', () => {

    expect(adjustHksvFrameRate(16)).toBe(24);
    expect(adjustHksvFrameRate(20)).toBe(24);
    expect(adjustHksvFrameRate(24)).toBe(24);
  });

  it('adjusts fps <= 15 to 15', () => {

    expect(adjustHksvFrameRate(10)).toBe(15);
    expect(adjustHksvFrameRate(15)).toBe(15);
    expect(adjustHksvFrameRate(1)).toBe(15);
  });

  it('leaves standard HomeKit frame rates unchanged', () => {

    // fps = 30 → 30 > 24 → 30.
    expect(adjustHksvFrameRate(30)).toBe(30);

    // fps = 24 → 24 is not > 24, but 24 > 15 → 24.
    expect(adjustHksvFrameRate(24)).toBe(24);

    // fps = 15 → 15 is not > 24, not > 15 → 15.
    expect(adjustHksvFrameRate(15)).toBe(15);
  });
});

describe('Resolution Filtering', () => {

  it('includes resolutions smaller than native', () => {

    expect(shouldIncludeResolution(1280, 1920)).toBe(true);
    expect(shouldIncludeResolution(640, 1920)).toBe(true);
  });

  it('excludes resolutions equal to or larger than native (non-required)', () => {

    expect(shouldIncludeResolution(3840, 1920)).toBe(false);
    expect(shouldIncludeResolution(2560, 1920)).toBe(false);
  });

  it('always includes 1920 even if equal to or larger than native', () => {

    // 1920 is required by HomeKit.
    expect(shouldIncludeResolution(1920, 1920)).toBe(true);
    expect(shouldIncludeResolution(1920, 1280)).toBe(true);
  });

  it('always includes 1280 even if equal to or larger than native', () => {

    // 1280 is required by HomeKit.
    expect(shouldIncludeResolution(1280, 1280)).toBe(true);
    expect(shouldIncludeResolution(1280, 640)).toBe(true);
  });

  it('applies the exception only for 1920 and 1280', () => {

    // 2560 is NOT a required resolution, so it's excluded when >= native.
    expect(shouldIncludeResolution(2560, 2560)).toBe(false);
    expect(shouldIncludeResolution(640, 640)).toBe(false);
  });
});
