/* Copyright(C) 2020-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * protect-options.test.ts: Tests for feature option definitions in protect-options.ts.
 */
import { featureOptionCategories, featureOptions } from '../src/protect-options.js';
import type { ProtectOptions, ProtectNvrOptions } from '../src/protect-options.js';

describe('Feature Option Categories', () => {

  it('should export a non-empty array of feature option categories', () => {

    expect(Array.isArray(featureOptionCategories)).toBe(true);
    expect(featureOptionCategories.length).toBeGreaterThan(0);
  });

  it('should have valid structure for every category (name, description, modelKey)', () => {

    for(const category of featureOptionCategories) {

      expect(category).toHaveProperty('name');
      expect(category).toHaveProperty('description');
      expect(category).toHaveProperty('modelKey');

      expect(typeof category.name).toBe('string');
      expect(category.name.length).toBeGreaterThan(0);

      expect(typeof category.description).toBe('string');
      expect(category.description.length).toBeGreaterThan(0);

      expect(Array.isArray(category.modelKey)).toBe(true);
      expect(category.modelKey.length).toBeGreaterThan(0);
    }
  });

  it('should have unique category names', () => {

    const names = featureOptionCategories.map(c => c.name);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
  });

  it('should only contain valid modelKey values', () => {

    const validModelKeys = ['all', 'camera', 'light', 'nvr', 'sensor'];

    for(const category of featureOptionCategories) {

      for(const key of category.modelKey) {

        expect(validModelKeys).toContain(key);
      }
    }
  });

  it('should include essential categories', () => {

    const names = featureOptionCategories.map(c => c.name);

    expect(names).toContain('Audio');
    expect(names).toContain('Device');
    expect(names).toContain('Doorbell');
    expect(names).toContain('Log');
    expect(names).toContain('Motion');
    expect(names).toContain('Nvr');
    expect(names).toContain('Video');
    expect(names).toContain('Video.HKSV');
  });
});

describe('Feature Options', () => {

  it('should export a non-empty record of feature options', () => {

    expect(typeof featureOptions).toBe('object');
    expect(Object.keys(featureOptions).length).toBeGreaterThan(0);
  });

  it('should have a feature options entry for every category', () => {

    for(const category of featureOptionCategories) {

      expect(featureOptions).toHaveProperty(category.name);
      expect(Array.isArray(featureOptions[category.name])).toBe(true);
      expect(featureOptions[category.name].length).toBeGreaterThan(0);
    }
  });

  it('should not have feature option keys that do not correspond to a category', () => {

    const categoryNames = new Set(featureOptionCategories.map(c => c.name));

    for(const key of Object.keys(featureOptions)) {

      expect(categoryNames.has(key)).toBe(true);
    }
  });

  describe('Feature option entry structure', () => {

    it('should have required fields (name, description, default) on every entry', () => {

      for(const [, entries] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          expect(entry).toHaveProperty('name');
          expect(entry).toHaveProperty('description');
          expect(entry).toHaveProperty('default');

          expect(typeof entry.name).toBe('string');
          expect(typeof entry.description).toBe('string');
          expect(typeof entry.default).toBe('boolean');

          // Description should not be empty.
          expect(entry.description.length).toBeGreaterThan(0);
        }
      }
    });

    it('should have valid defaultValue types when present (number or string)', () => {

      for(const [, entries] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          if('defaultValue' in entry && entry.defaultValue !== undefined) {

            expect(typeof entry.defaultValue === 'number' || typeof entry.defaultValue === 'string').toBe(true);
          }
        }
      }
    });

    it('should have valid group references when present', () => {

      for(const [, entries] of Object.entries(featureOptions)) {

        const entryNames = new Set(entries.map(e => e.name));

        for(const entry of entries) {

          if(entry.group) {

            // The group should reference another entry name in the same category.
            expect(entryNames.has(entry.group)).toBe(true);
          }
        }
      }
    });

    it('should have valid inputSize when present (positive number)', () => {

      for(const [, entries] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          if('inputSize' in entry && entry.inputSize !== undefined) {

            expect(typeof entry.inputSize).toBe('number');
            expect(entry.inputSize).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe('No duplicate feature option keys', () => {

    it('should have no duplicate qualified keys (category.name) across all categories', () => {

      const allKeys: string[] = [];

      for(const [category, entries] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          // Build the fully qualified key: Category or Category.Name.
          const qualifiedKey = entry.name.length > 0 ? category + '.' + entry.name : category;

          allKeys.push(qualifiedKey);
        }
      }

      const uniqueKeys = new Set(allKeys);

      expect(uniqueKeys.size).toBe(allKeys.length);
    });

    it('should have no duplicate entry names within a single category', () => {

      for(const [, entries] of Object.entries(featureOptions)) {

        const names = entries.map(e => e.name);
        const uniqueNames = new Set(names);

        expect(uniqueNames.size).toBe(names.length);
      }
    });
  });

  describe('Specific feature option expectations', () => {

    it('should have a base device option with an empty name (category-level toggle)', () => {

      const deviceOptions = featureOptions.Device;
      const baseOption = deviceOptions.find(e => e.name === '');

      expect(baseOption).toBeDefined();
      expect(baseOption!.default).toBe(true);
    });

    it('should have a base audio option with an empty name', () => {

      const audioOptions = featureOptions.Audio;
      const baseOption = audioOptions.find(e => e.name === '');

      expect(baseOption).toBeDefined();
      expect(baseOption!.default).toBe(true);
    });

    it('should have motion duration with a numeric default value', () => {

      const motionOptions = featureOptions.Motion;
      const durationOption = motionOptions.find(e => e.name === 'Duration');

      expect(durationOption).toBeDefined();
      expect(typeof durationOption!.defaultValue).toBe('number');
      expect(durationOption!.defaultValue).toBeGreaterThan(0);
    });

    it('should have occupancy sensor duration with a numeric default value', () => {

      const motionOptions = featureOptions.Motion;
      const durationOption = motionOptions.find(e => e.name === 'OccupancySensor.Duration');

      expect(durationOption).toBeDefined();
      expect(typeof durationOption!.defaultValue).toBe('number');
      expect(durationOption!.defaultValue).toBeGreaterThan(0);
    });

    it('should have smart detection options under Motion category', () => {

      const motionOptions = featureOptions.Motion;

      expect(motionOptions.find(e => e.name === 'SmartDetect')).toBeDefined();
      expect(motionOptions.find(e => e.name === 'SmartDetect.ObjectSensors')).toBeDefined();
    });

    it('should have HKSV recording options under Video.HKSV category', () => {

      const hksvOptions = featureOptions['Video.HKSV'];

      expect(hksvOptions).toBeDefined();
      expect(hksvOptions.find(e => e.name === 'Recording.Switch')).toBeDefined();
    });
  });
});

describe('ProtectOptions type interface', () => {

  it('should accept a valid ProtectOptions configuration', () => {

    // This test validates at runtime that the type structure matches expectations.
    const config: ProtectOptions = {

      controllers: [],
      debugAll: false,
      options: [],
      ringDelay: 0,
      verboseFfmpeg: false,
      videoProcessor: 'ffmpeg',
    };

    expect(config).toHaveProperty('controllers');
    expect(config).toHaveProperty('debugAll');
    expect(config).toHaveProperty('options');
    expect(config).toHaveProperty('ringDelay');
    expect(config).toHaveProperty('verboseFfmpeg');
    expect(config).toHaveProperty('videoProcessor');

    expect(Array.isArray(config.controllers)).toBe(true);
    expect(typeof config.debugAll).toBe('boolean');
    expect(Array.isArray(config.options)).toBe(true);
    expect(typeof config.ringDelay).toBe('number');
    expect(typeof config.verboseFfmpeg).toBe('boolean');
    expect(typeof config.videoProcessor).toBe('string');
  });

  it('should accept a valid ProtectNvrOptions configuration', () => {

    const nvrConfig: ProtectNvrOptions = {

      address: '192.168.1.1',
      mqttTopic: 'unifi/protect',
      password: 'password',
      username: 'admin',
    };

    expect(nvrConfig).toHaveProperty('address');
    expect(nvrConfig).toHaveProperty('mqttTopic');
    expect(nvrConfig).toHaveProperty('username');
    expect(nvrConfig).toHaveProperty('password');

    expect(typeof nvrConfig.address).toBe('string');
    expect(typeof nvrConfig.mqttTopic).toBe('string');
    expect(typeof nvrConfig.username).toBe('string');
    expect(typeof nvrConfig.password).toBe('string');
  });

  it('should accept ProtectNvrOptions with optional fields', () => {

    const nvrConfig: ProtectNvrOptions = {

      address: '192.168.1.1',
      doorbellMessages: [
        { duration: 60000, message: 'Welcome' },
        { duration: 60000, message: 'Leave a package' },
      ],
      mqttTopic: 'unifi/protect',
      mqttUrl: 'mqtt://localhost:1883',
      name: 'My NVR',
      overrideAddress: '10.0.0.1',
      password: 'password',
      username: 'admin',
    };

    expect(nvrConfig.doorbellMessages).toHaveLength(2);
    expect(nvrConfig.doorbellMessages![0].message).toBe('Welcome');
    expect(nvrConfig.doorbellMessages![0].duration).toBe(60000);
    expect(nvrConfig.mqttUrl).toBe('mqtt://localhost:1883');
    expect(nvrConfig.name).toBe('My NVR');
    expect(nvrConfig.overrideAddress).toBe('10.0.0.1');
  });

  it('should accept ProtectOptions with populated controllers', () => {

    const config: ProtectOptions = {

      controllers: [
        {
          address: '192.168.1.1',
          mqttTopic: 'unifi/protect',
          password: 'pass',
          username: 'admin',
        },
        {
          address: '192.168.1.2',
          mqttTopic: 'unifi/protect2',
          name: 'Secondary NVR',
          password: 'pass2',
          username: 'admin2',
        },
      ],
      debugAll: true,
      options: ['Enable.Device', 'Disable.Audio'],
      ringDelay: 5,
      verboseFfmpeg: true,
      videoProcessor: '/usr/bin/ffmpeg',
    };

    expect(config.controllers).toHaveLength(2);
    expect(config.controllers[0].address).toBe('192.168.1.1');
    expect(config.controllers[1].name).toBe('Secondary NVR');
    expect(config.options).toContain('Enable.Device');
    expect(config.ringDelay).toBe(5);
  });
});
