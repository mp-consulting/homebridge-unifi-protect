/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * event-timers.test.ts: Tests for the event timer management patterns used in protect-events.ts.
 *
 * These tests verify the timer key patterns and lifecycle management in isolation, without needing
 * to instantiate the full ProtectEvents class or its Homebridge dependencies.
 */

// Timer key builder helpers that mirror the patterns in protect-events.ts.
function motionKey(deviceId: string): string {

  return deviceId;
}

function occupancyKey(deviceId: string): string {

  return deviceId + '.Motion.OccupancySensor';
}

function smartDetectKey(deviceId: string, objectType: string): string {

  return deviceId + '.Motion.SmartDetect.ObjectSensors.' + objectType;
}

function licensePlateKey(deviceId: string, plate: string): string {

  return smartDetectKey(deviceId, 'vehicle') + '.' + plate;
}

function doorbellRingKey(deviceId: string): string {

  return deviceId + '.Doorbell.Ring';
}

function doorbellTriggerKey(deviceId: string): string {

  return deviceId + '.Doorbell.Ring.Trigger';
}

function doorbellMqttKey(deviceId: string): string {

  return deviceId + '.Doorbell.Ring.MQTT';
}

describe('Event Timer Key Management', () => {

  const DEVICE_A = 'aaaaaaaaaaaa';
  const DEVICE_B = 'bbbbbbbbbbbb';

  describe('Timer key uniqueness', () => {

    it('should produce distinct keys for all event types on the same device', () => {

      const keys = [
        motionKey(DEVICE_A),
        occupancyKey(DEVICE_A),
        smartDetectKey(DEVICE_A, 'person'),
        smartDetectKey(DEVICE_A, 'vehicle'),
        smartDetectKey(DEVICE_A, 'animal'),
        doorbellRingKey(DEVICE_A),
        doorbellTriggerKey(DEVICE_A),
        doorbellMqttKey(DEVICE_A),
      ];

      const uniqueKeys = new Set(keys);

      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('should produce distinct keys for the same event type on different devices', () => {

      expect(motionKey(DEVICE_A)).not.toBe(motionKey(DEVICE_B));
      expect(occupancyKey(DEVICE_A)).not.toBe(occupancyKey(DEVICE_B));
      expect(smartDetectKey(DEVICE_A, 'person')).not.toBe(smartDetectKey(DEVICE_B, 'person'));
      expect(doorbellRingKey(DEVICE_A)).not.toBe(doorbellRingKey(DEVICE_B));
      expect(doorbellTriggerKey(DEVICE_A)).not.toBe(doorbellTriggerKey(DEVICE_B));
      expect(doorbellMqttKey(DEVICE_A)).not.toBe(doorbellMqttKey(DEVICE_B));
    });

    it('should produce distinct keys for different smart detection object types', () => {

      const types = ['person', 'vehicle', 'animal', 'face', 'package', 'licensePlate'];
      const keys = types.map(type => smartDetectKey(DEVICE_A, type));
      const uniqueKeys = new Set(keys);

      expect(uniqueKeys.size).toBe(types.length);
    });

    it('should produce distinct keys for different license plates on the same device', () => {

      const plates = ['ABC1234', 'XYZ9876', 'TEST000'];
      const keys = plates.map(plate => licensePlateKey(DEVICE_A, plate));
      const uniqueKeys = new Set(keys);

      expect(uniqueKeys.size).toBe(plates.length);
    });

    it('should not collide between a license plate key and a smart detect key', () => {

      // The license plate key is an extension of the vehicle smart detect key.
      const vehicleKey = smartDetectKey(DEVICE_A, 'vehicle');
      const plateKey = licensePlateKey(DEVICE_A, 'ABC1234');

      expect(plateKey).not.toBe(vehicleKey);
      expect(plateKey.startsWith(vehicleKey)).toBe(true);
    });
  });

  describe('Timer key format verification', () => {

    it('should use the bare device ID for motion events', () => {

      expect(motionKey(DEVICE_A)).toBe(DEVICE_A);
    });

    it('should use the compound key with .Motion.OccupancySensor suffix for occupancy events', () => {

      const key = occupancyKey(DEVICE_A);

      expect(key).toBe(DEVICE_A + '.Motion.OccupancySensor');
      expect(key).not.toBe(DEVICE_A);
    });

    it('should include the object type in smart detection keys', () => {

      const key = smartDetectKey(DEVICE_A, 'person');

      expect(key).toBe(DEVICE_A + '.Motion.SmartDetect.ObjectSensors.person');
      expect(key).toContain('person');
    });

    it('should use .Doorbell.Ring suffix for doorbell ring debounce', () => {

      expect(doorbellRingKey(DEVICE_A)).toBe(DEVICE_A + '.Doorbell.Ring');
    });

    it('should use .Doorbell.Ring.Trigger suffix for doorbell trigger switch', () => {

      expect(doorbellTriggerKey(DEVICE_A)).toBe(DEVICE_A + '.Doorbell.Ring.Trigger');
    });

    it('should use .Doorbell.Ring.MQTT suffix for doorbell MQTT events', () => {

      expect(doorbellMqttKey(DEVICE_A)).toBe(DEVICE_A + '.Doorbell.Ring.MQTT');
    });
  });
});

describe('Event Timer Lifecycle', () => {

  let eventTimers: Map<string, NodeJS.Timeout | undefined>;
  const DEVICE_ID = 'camera001';

  beforeEach(() => {

    vi.useFakeTimers();
    eventTimers = new Map();
  });

  afterEach(() => {

    // Clean up any remaining timers.
    for(const timer of eventTimers.values()) {

      if(timer) {

        clearTimeout(timer);
      }
    }

    eventTimers.clear();
    vi.useRealTimers();
  });

  describe('Motion timer set/clear/delete lifecycle', () => {

    it('should register a new motion timer when no timer exists for the device', () => {

      const key = motionKey(DEVICE_ID);

      expect(eventTimers.has(key)).toBe(false);

      // Simulate: first motion event sets a timer.
      eventTimers.set(key, setTimeout(() => {

        eventTimers.delete(key);
      }, 10000));

      expect(eventTimers.has(key)).toBe(true);
      expect(eventTimers.get(key)).toBeDefined();
    });

    it('should clear and replace the timer on subsequent motion events', () => {

      const key = motionKey(DEVICE_ID);

      // First motion event.
      eventTimers.set(key, setTimeout(() => {

        eventTimers.delete(key);
      }, 10000));

      const firstTimer = eventTimers.get(key);

      // Second motion event: clear existing timer, set new one (as protect-events.ts does).
      clearTimeout(eventTimers.get(key));

      eventTimers.set(key, setTimeout(() => {

        eventTimers.delete(key);
      }, 10000));

      const secondTimer = eventTimers.get(key);

      expect(eventTimers.has(key)).toBe(true);
      expect(secondTimer).not.toBe(firstTimer);
    });

    it('should delete the timer entry when the timer fires', () => {

      const key = motionKey(DEVICE_ID);

      eventTimers.set(key, setTimeout(() => {

        eventTimers.delete(key);
      }, 10000));

      expect(eventTimers.has(key)).toBe(true);

      // Advance time so the timer fires.
      vi.advanceTimersByTime(10000);

      expect(eventTimers.has(key)).toBe(false);
    });

    it('should not fire the old timer after it has been cleared and replaced', () => {

      const key = motionKey(DEVICE_ID);
      const firstCallback = vi.fn();
      const secondCallback = vi.fn();

      // First motion event.
      eventTimers.set(key, setTimeout(() => {

        firstCallback();
        eventTimers.delete(key);
      }, 10000));

      // Advance partially.
      vi.advanceTimersByTime(5000);

      // Second motion event: clear and replace.
      clearTimeout(eventTimers.get(key));

      eventTimers.set(key, setTimeout(() => {

        secondCallback();
        eventTimers.delete(key);
      }, 10000));

      // Advance past the original timer's scheduled time.
      vi.advanceTimersByTime(5000);

      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).not.toHaveBeenCalled();

      // Advance to fire the replacement timer.
      vi.advanceTimersByTime(5000);

      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).toHaveBeenCalledTimes(1);
      expect(eventTimers.has(key)).toBe(false);
    });
  });

  describe('Occupancy timer uses the correct compound key', () => {

    it('should store the occupancy timer under the compound key, not the bare device ID', () => {

      const occupancy = occupancyKey(DEVICE_ID);
      const motion = motionKey(DEVICE_ID);

      // Simulate occupancy timer creation (as in handleOccupancy).
      eventTimers.set(occupancy, setTimeout(() => {

        eventTimers.delete(occupancy);
      }, 300000));

      expect(eventTimers.has(occupancy)).toBe(true);
      expect(eventTimers.has(motion)).toBe(false);
    });

    it('should not interfere with the motion timer when checking or clearing the occupancy timer', () => {

      const occupancy = occupancyKey(DEVICE_ID);
      const motion = motionKey(DEVICE_ID);

      // Simulate both timers active simultaneously.
      eventTimers.set(motion, setTimeout(() => {

        eventTimers.delete(motion);
      }, 10000));

      eventTimers.set(occupancy, setTimeout(() => {

        eventTimers.delete(occupancy);
      }, 300000));

      // Clear only the occupancy timer (as handleOccupancy does before resetting).
      clearTimeout(eventTimers.get(occupancy));

      eventTimers.set(occupancy, setTimeout(() => {

        eventTimers.delete(occupancy);
      }, 300000));

      // Motion timer should still be intact.
      expect(eventTimers.has(motion)).toBe(true);
      expect(eventTimers.has(occupancy)).toBe(true);

      // Fire the motion timer.
      vi.advanceTimersByTime(10000);

      expect(eventTimers.has(motion)).toBe(false);
      expect(eventTimers.has(occupancy)).toBe(true);
    });

    it('should use the occupancyDuration for the occupancy timer, not motionDuration', () => {

      const occupancy = occupancyKey(DEVICE_ID);
      const OCCUPANCY_DURATION = 300; // seconds (default from settings.ts)

      eventTimers.set(occupancy, setTimeout(() => {

        eventTimers.delete(occupancy);
      }, OCCUPANCY_DURATION * 1000));

      // After 10 seconds (motionDuration default), occupancy timer should still be active.
      vi.advanceTimersByTime(10000);
      expect(eventTimers.has(occupancy)).toBe(true);

      // After the full occupancy duration, it should be cleared.
      vi.advanceTimersByTime(290000);
      expect(eventTimers.has(occupancy)).toBe(false);
    });
  });

  describe('Smart detection timers use the correct compound key with object type', () => {

    it('should create separate timer entries for each smart detection type', () => {

      const personKey = smartDetectKey(DEVICE_ID, 'person');
      const vehicleKey = smartDetectKey(DEVICE_ID, 'vehicle');

      eventTimers.set(personKey, setTimeout(() => {

        eventTimers.delete(personKey);
      }, 10000));

      eventTimers.set(vehicleKey, setTimeout(() => {

        eventTimers.delete(vehicleKey);
      }, 10000));

      expect(eventTimers.has(personKey)).toBe(true);
      expect(eventTimers.has(vehicleKey)).toBe(true);
      expect(eventTimers.size).toBe(2);
    });

    it('should include the object type in the key to avoid collisions', () => {

      const personKey = smartDetectKey(DEVICE_ID, 'person');

      expect(personKey).toContain('.person');
      expect(personKey).not.toContain('.vehicle');
    });

    it('should clear only the specific smart detection type timer', () => {

      const personKey = smartDetectKey(DEVICE_ID, 'person');
      const vehicleKey = smartDetectKey(DEVICE_ID, 'vehicle');
      const animalKey = smartDetectKey(DEVICE_ID, 'animal');

      eventTimers.set(personKey, setTimeout(() => eventTimers.delete(personKey), 10000));
      eventTimers.set(vehicleKey, setTimeout(() => eventTimers.delete(vehicleKey), 10000));
      eventTimers.set(animalKey, setTimeout(() => eventTimers.delete(animalKey), 10000));

      // Clear only the vehicle timer (simulating a re-trigger of a vehicle event).
      clearTimeout(eventTimers.get(vehicleKey));
      eventTimers.set(vehicleKey, setTimeout(() => eventTimers.delete(vehicleKey), 10000));

      expect(eventTimers.has(personKey)).toBe(true);
      expect(eventTimers.has(vehicleKey)).toBe(true);
      expect(eventTimers.has(animalKey)).toBe(true);
    });
  });

  describe('Multiple timers for the same device can coexist independently', () => {

    it('should support motion, occupancy, smart detection, and doorbell timers simultaneously', () => {

      const keys = {

        doorbell: doorbellRingKey(DEVICE_ID),
        doorbellMqtt: doorbellMqttKey(DEVICE_ID),
        doorbellTrigger: doorbellTriggerKey(DEVICE_ID),
        motion: motionKey(DEVICE_ID),
        occupancy: occupancyKey(DEVICE_ID),
        smartPerson: smartDetectKey(DEVICE_ID, 'person'),
        smartVehicle: smartDetectKey(DEVICE_ID, 'vehicle'),
      };

      // Set all timers with different durations.
      eventTimers.set(keys.motion, setTimeout(() => eventTimers.delete(keys.motion), 10000));
      eventTimers.set(keys.occupancy, setTimeout(() => eventTimers.delete(keys.occupancy), 300000));
      eventTimers.set(keys.smartPerson, setTimeout(() => eventTimers.delete(keys.smartPerson), 10000));
      eventTimers.set(keys.smartVehicle, setTimeout(() => eventTimers.delete(keys.smartVehicle), 10000));
      eventTimers.set(keys.doorbell, setTimeout(() => eventTimers.delete(keys.doorbell), 5000));
      eventTimers.set(keys.doorbellTrigger, setTimeout(() => eventTimers.delete(keys.doorbellTrigger), 5000));
      eventTimers.set(keys.doorbellMqtt, setTimeout(() => eventTimers.delete(keys.doorbellMqtt), 5000));

      expect(eventTimers.size).toBe(7);

      // Verify all keys are present.
      for(const key of Object.values(keys)) {

        expect(eventTimers.has(key)).toBe(true);
      }
    });

    it('should allow doorbell timers to expire independently from motion timers', () => {

      const motionK = motionKey(DEVICE_ID);
      const doorbellK = doorbellRingKey(DEVICE_ID);
      const doorbellTriggerK = doorbellTriggerKey(DEVICE_ID);
      const doorbellMqttK = doorbellMqttKey(DEVICE_ID);

      eventTimers.set(motionK, setTimeout(() => eventTimers.delete(motionK), 10000));
      eventTimers.set(doorbellK, setTimeout(() => eventTimers.delete(doorbellK), 5000));
      eventTimers.set(doorbellTriggerK, setTimeout(() => eventTimers.delete(doorbellTriggerK), 5000));
      eventTimers.set(doorbellMqttK, setTimeout(() => eventTimers.delete(doorbellMqttK), 5000));

      // Doorbell timers expire first (5 seconds).
      vi.advanceTimersByTime(5000);

      expect(eventTimers.has(doorbellK)).toBe(false);
      expect(eventTimers.has(doorbellTriggerK)).toBe(false);
      expect(eventTimers.has(doorbellMqttK)).toBe(false);
      expect(eventTimers.has(motionK)).toBe(true);

      // Motion timer expires at 10 seconds.
      vi.advanceTimersByTime(5000);

      expect(eventTimers.has(motionK)).toBe(false);
      expect(eventTimers.size).toBe(0);
    });

    it('should handle timers for multiple devices without interference', () => {

      const DEVICE_A = 'camera_front';
      const DEVICE_B = 'camera_back';

      const motionA = motionKey(DEVICE_A);
      const motionB = motionKey(DEVICE_B);
      const occupancyA = occupancyKey(DEVICE_A);
      const occupancyB = occupancyKey(DEVICE_B);

      eventTimers.set(motionA, setTimeout(() => eventTimers.delete(motionA), 10000));
      eventTimers.set(motionB, setTimeout(() => eventTimers.delete(motionB), 10000));
      eventTimers.set(occupancyA, setTimeout(() => eventTimers.delete(occupancyA), 300000));
      eventTimers.set(occupancyB, setTimeout(() => eventTimers.delete(occupancyB), 300000));

      expect(eventTimers.size).toBe(4);

      // Clear only device A's motion timer.
      clearTimeout(eventTimers.get(motionA));
      eventTimers.delete(motionA);

      expect(eventTimers.has(motionA)).toBe(false);
      expect(eventTimers.has(motionB)).toBe(true);
      expect(eventTimers.has(occupancyA)).toBe(true);
      expect(eventTimers.has(occupancyB)).toBe(true);
    });
  });

  describe('Timer cleanup removes the correct entry', () => {

    it('should remove only the targeted timer key on delete', () => {

      const motion = motionKey(DEVICE_ID);
      const occupancy = occupancyKey(DEVICE_ID);
      const smart = smartDetectKey(DEVICE_ID, 'person');

      eventTimers.set(motion, setTimeout(() => {}, 10000));
      eventTimers.set(occupancy, setTimeout(() => {}, 300000));
      eventTimers.set(smart, setTimeout(() => {}, 10000));

      expect(eventTimers.size).toBe(3);

      // Delete the motion timer.
      clearTimeout(eventTimers.get(motion));
      eventTimers.delete(motion);

      expect(eventTimers.size).toBe(2);
      expect(eventTimers.has(motion)).toBe(false);
      expect(eventTimers.has(occupancy)).toBe(true);
      expect(eventTimers.has(smart)).toBe(true);
    });

    it('should handle clearing a timer that does not exist without error', () => {

      const nonExistentKey = motionKey('nonexistent_device');

      // This mirrors the pattern in protect-events.ts where clearTimeout is called
      // with eventTimers.get() which returns undefined for missing keys.
      expect(() => {

        clearTimeout(eventTimers.get(nonExistentKey));
      }).not.toThrow();

      expect(() => {

        eventTimers.delete(nonExistentKey);
      }).not.toThrow();
    });

    it('should correctly reflect timer state after full set-clear-delete cycle', () => {

      const key = motionKey(DEVICE_ID);

      // Set.
      eventTimers.set(key, setTimeout(() => eventTimers.delete(key), 10000));
      expect(eventTimers.has(key)).toBe(true);

      // Clear the timeout.
      clearTimeout(eventTimers.get(key));

      // The key is still in the map (clearTimeout does not remove it from the map).
      expect(eventTimers.has(key)).toBe(true);

      // Delete removes it.
      eventTimers.delete(key);
      expect(eventTimers.has(key)).toBe(false);
    });

    it('should support the doorbell clear-delete-set pattern used for trigger resets', () => {

      const triggerKey = doorbellTriggerKey(DEVICE_ID);

      // First doorbell ring: set the trigger timer.
      eventTimers.set(triggerKey, setTimeout(() => {

        eventTimers.delete(triggerKey);
      }, 5000));

      expect(eventTimers.has(triggerKey)).toBe(true);

      // Second doorbell ring within the trigger duration: clear, delete, then set a new timer.
      // This is the exact pattern from doorbellEventHandler.
      if(eventTimers.has(triggerKey)) {

        clearTimeout(eventTimers.get(triggerKey));
        eventTimers.delete(triggerKey);
      }

      expect(eventTimers.has(triggerKey)).toBe(false);

      eventTimers.set(triggerKey, setTimeout(() => {

        eventTimers.delete(triggerKey);
      }, 5000));

      expect(eventTimers.has(triggerKey)).toBe(true);

      // Let the timer expire.
      vi.advanceTimersByTime(5000);

      expect(eventTimers.has(triggerKey)).toBe(false);
    });
  });

  describe('Doorbell ring debounce pattern', () => {

    it('should block subsequent rings while the debounce timer is active', () => {

      const ringKey = doorbellRingKey(DEVICE_ID);
      const ringCount = { value: 0 };

      // Simulate the doorbell ring debounce pattern from doorbellEventHandler.
      const simulateRing = (): boolean => {

        // If we have an inflight ring event, we're done (return early, ring blocked).
        if(eventTimers.has(ringKey)) {

          return false;
        }

        ringCount.value++;

        // Set the debounce timer.
        eventTimers.set(ringKey, setTimeout(() => {

          eventTimers.delete(ringKey);
        }, 3000)); // ringDelay * 1000

        return true;
      };

      // First ring goes through.
      expect(simulateRing()).toBe(true);
      expect(ringCount.value).toBe(1);

      // Second ring is blocked.
      expect(simulateRing()).toBe(false);
      expect(ringCount.value).toBe(1);

      // After debounce expires, next ring goes through.
      vi.advanceTimersByTime(3000);

      expect(simulateRing()).toBe(true);
      expect(ringCount.value).toBe(2);
    });
  });
});
