/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * recording-duration.test.ts: Tests for the HKSV recording duration formatting logic from protect-record.ts.
 *
 * The duration formatting logic from stopTransmitting() is tested in isolation.
 */

// Reproduction of the recording duration formatting logic from ProtectRecordingDelegate.stopTransmitting().
function formatRecordingDuration(timeshiftedSegments: number, segmentLength: number): { time: string; unit: string } {

  const recordedSeconds = (timeshiftedSegments * segmentLength) / 1000;

  let recordedTime = '';

  const hours = Math.floor(recordedSeconds / 3600);
  const minutes = Math.floor((recordedSeconds % 3600) / 60);
  const seconds = Math.floor((recordedSeconds % 3600) % 60);

  if(recordedSeconds < 1) {

    recordedTime = recordedSeconds.toString();
  } else if(recordedSeconds < 60) {

    recordedTime = Math.round(recordedSeconds).toString();
  } else {

    if(hours > 9) {

      recordedTime = hours.toString() + ':';
    } else if(hours > 0) {

      recordedTime = '0' + hours.toString() + ':';
    }

    if(minutes > 9) {

      recordedTime += minutes.toString() + ':';
    } else if(minutes > 0) {

      recordedTime += (hours > 0) ? '0' : '' + minutes.toString() + ':';
    }

    if(recordedTime.length && (seconds < 10)) {

      recordedTime += '0' + seconds.toString();
    } else {

      recordedTime += seconds ? seconds.toString() : recordedSeconds.toString();
    }
  }

  let timeUnit;

  switch(recordedTime.split(':').length - 1) {

    case 1:

      timeUnit = 'minute';

      break;

    case 2:

      timeUnit = 'hour';

      break;

    default:

      timeUnit = 'second';

      break;
  }

  return { time: recordedTime, unit: timeUnit };
}

describe('Recording Duration Formatting', () => {

  const SEGMENT_LENGTH = 250; // Typical segment length in ms.

  describe('sub-second recordings', () => {

    it('formats 0 segments as "0" seconds', () => {

      const result = formatRecordingDuration(0, SEGMENT_LENGTH);

      expect(result.time).toBe('0');
      expect(result.unit).toBe('second');
    });

    it('formats sub-second duration', () => {

      // 2 segments * 250ms = 500ms = 0.5 seconds.
      const result = formatRecordingDuration(2, SEGMENT_LENGTH);

      expect(result.time).toBe('0.5');
      expect(result.unit).toBe('second');
    });

    it('formats 1 segment as sub-second', () => {

      // 1 segment * 250ms = 250ms = 0.25 seconds.
      const result = formatRecordingDuration(1, SEGMENT_LENGTH);

      expect(result.time).toBe('0.25');
      expect(result.unit).toBe('second');
    });
  });

  describe('second-range recordings (1-59 seconds)', () => {

    it('formats exactly 1 second', () => {

      // 4 segments * 250ms = 1000ms = 1 second.
      const result = formatRecordingDuration(4, SEGMENT_LENGTH);

      expect(result.time).toBe('1');
      expect(result.unit).toBe('second');
    });

    it('formats 30 seconds', () => {

      // 120 segments * 250ms = 30000ms = 30 seconds.
      const result = formatRecordingDuration(120, SEGMENT_LENGTH);

      expect(result.time).toBe('30');
      expect(result.unit).toBe('second');
    });

    it('formats 59 seconds', () => {

      // 236 segments * 250ms = 59000ms = 59 seconds.
      const result = formatRecordingDuration(236, SEGMENT_LENGTH);

      expect(result.time).toBe('59');
      expect(result.unit).toBe('second');
    });
  });

  describe('minute-range recordings (1+ minutes)', () => {

    it('formats exactly 1 minute', () => {

      // 240 segments * 250ms = 60000ms = 60 seconds.
      const result = formatRecordingDuration(240, SEGMENT_LENGTH);

      expect(result.time).toContain(':');
      expect(result.unit).toBe('minute');
    });

    it('formats 1 minute 30 seconds', () => {

      // 360 segments * 250ms = 90000ms = 90 seconds = 1:30.
      const result = formatRecordingDuration(360, SEGMENT_LENGTH);

      expect(result.unit).toBe('minute');
    });

    it('formats 5 minutes exactly', () => {

      // 1200 segments * 250ms = 300000ms = 300 seconds = 5:00.
      const result = formatRecordingDuration(1200, SEGMENT_LENGTH);

      expect(result.unit).toBe('minute');
    });

    it('formats 10 minutes 15 seconds', () => {

      // 2460 segments * 250ms = 615000ms = 615 seconds = 10:15.
      const result = formatRecordingDuration(2460, SEGMENT_LENGTH);

      expect(result.unit).toBe('minute');
    });
  });

  describe('hour-range recordings', () => {

    it('formats exactly 1 hour as minute-unit (minutes=0 skips minutes separator)', () => {

      // 14400 segments * 250ms = 3600 seconds. hours=1, minutes=0 → "01:00" (one colon).
      const result = formatRecordingDuration(14400, SEGMENT_LENGTH);

      // When minutes=0, the minutes colon is not emitted, producing only one colon.
      expect(result.time).toBe('01:00');
      expect(result.unit).toBe('minute');
    });

    it('formats hours with non-zero minutes as hour-unit', () => {

      // 36000 segments * 250ms = 9000 seconds = 2h 30m. hours=2, minutes=30 → "02:30:00".
      const result = formatRecordingDuration(36000, SEGMENT_LENGTH);

      expect(result.time).toBe('02:30:00');
      expect(result.unit).toBe('hour');
    });

    it('formats 1 hour 15 minutes', () => {

      // 18000 segments * 250ms = 4500 seconds = 1h 15m. → "01:15:00".
      const result = formatRecordingDuration(18000, SEGMENT_LENGTH);

      expect(result.time).toBe('01:15:00');
      expect(result.unit).toBe('hour');
    });

    it('formats 10+ hours with minutes=0 as minute-unit', () => {

      // 144000 segments * 250ms = 36000 seconds = 10h. hours=10, minutes=0 → "10:00".
      const result = formatRecordingDuration(144000, SEGMENT_LENGTH);

      expect(result.time).toBe('10:00');
      expect(result.unit).toBe('minute');
    });

    it('formats 10+ hours with non-zero minutes as hour-unit', () => {

      // 151200 segments * 250ms = 37800 seconds = 10h 30m. → "10:30:00".
      const result = formatRecordingDuration(151200, SEGMENT_LENGTH);

      expect(result.time).toBe('10:30:00');
      expect(result.unit).toBe('hour');
    });
  });

  describe('time unit detection', () => {

    it('returns "second" for no colons', () => {

      const result = formatRecordingDuration(40, SEGMENT_LENGTH); // 10 seconds.

      expect(result.unit).toBe('second');
    });

    it('returns "minute" for one colon', () => {

      const result = formatRecordingDuration(480, SEGMENT_LENGTH); // 120 seconds = 2 minutes.

      expect(result.unit).toBe('minute');
    });

    it('returns "hour" for two colons', () => {

      // 1 hour 15 minutes = 4500 seconds = 18000 segments. Output: "01:15:00" (two colons).
      const result = formatRecordingDuration(18000, SEGMENT_LENGTH);

      expect(result.unit).toBe('hour');
    });
  });

  describe('different segment lengths', () => {

    it('works with 100ms segments', () => {

      // 600 segments * 100ms = 60000ms = 60 seconds.
      const result = formatRecordingDuration(600, 100);

      expect(result.unit).toBe('minute');
    });

    it('works with 500ms segments', () => {

      // 120 segments * 500ms = 60000ms = 60 seconds.
      const result = formatRecordingDuration(120, 500);

      expect(result.unit).toBe('minute');
    });

    it('works with 1000ms segments', () => {

      // 30 segments * 1000ms = 30000ms = 30 seconds.
      const result = formatRecordingDuration(30, 1000);

      expect(result.time).toBe('30');
      expect(result.unit).toBe('second');
    });
  });
});
