/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * fmp4-parsing.test.ts: Tests for the fMP4 (ISO BMFF) box parsing utilities.
 */
import { BOX_HEADER_SIZE, findBox, hasAudioTrack, isKeyframe, splitMoofMdat } from '../src/lib/ffmpeg/fmp4.js';
import { describe, expect, it } from 'vitest';

// Construct an ISO BMFF box: a 32-bit big-endian size, a four-character type code, and the payload.
function box(type: string, payload: Buffer): Buffer {

  const header = Buffer.alloc(BOX_HEADER_SIZE);

  header.writeUInt32BE(BOX_HEADER_SIZE + payload.length, 0);
  header.write(type, 4, 'ascii');

  return Buffer.concat([ header, payload ]);
}

// Construct a trun fullbox with the given flags, sample count, and trailing fields.
function trun(flags: number, sampleCount: number, fields: number[]): Buffer {

  const body = Buffer.alloc(8 + (fields.length * 4));

  body.writeUInt32BE(flags & 0x00FFFFFF, 0);
  body.writeUInt32BE(sampleCount, 4);

  fields.forEach((value, index) => body.writeUInt32BE(value, 8 + (index * 4)));

  return box('trun', body);
}

// A hdlr fullbox with the given handler type: version/flags + pre_defined + handler_type + reserved + name.
function hdlr(handlerType: string): Buffer {

  const body = Buffer.alloc(24);

  body.write(handlerType, 8, 'ascii');

  return box('hdlr', body);
}

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const SAMPLE_NON_SYNC = 0x00010000;

describe('findBox', () => {

  const layout = Buffer.concat([ box('ftyp', Buffer.alloc(4)), box('moov', box('trak', Buffer.alloc(2))), box('moof', Buffer.alloc(1)) ]);

  it('locates top-level boxes by type', () => {

    const moov = findBox(layout, 'moov');

    expect(moov).not.toBeNull();
    expect(moov?.size).toBe(BOX_HEADER_SIZE + BOX_HEADER_SIZE + 2);

    expect(findBox(layout, 'moof')?.offset).toBe(layout.length - BOX_HEADER_SIZE - 1);
  });

  it('respects search ranges for nested boxes', () => {

    const moov = findBox(layout, 'moov');
    const trak = findBox(layout, 'trak', (moov?.offset ?? 0) + BOX_HEADER_SIZE, (moov?.offset ?? 0) + (moov?.size ?? 0));

    expect(trak).not.toBeNull();
  });

  it('returns null for absent types and malformed sizes', () => {

    expect(findBox(layout, 'mdat')).toBeNull();

    // A declared box size smaller than the header is malformed.
    const malformed = Buffer.alloc(BOX_HEADER_SIZE);

    malformed.writeUInt32BE(3, 0);
    malformed.write('free', 4, 'ascii');

    expect(findBox(malformed, 'free')).toBeNull();
  });
});

describe('isKeyframe', () => {

  const segment = (trunBox: Buffer): Buffer => Buffer.concat([ box('moof', box('traf', trunBox)), box('mdat', Buffer.alloc(4)) ]);

  it('detects a sync sample via first_sample_flags', () => {

    expect(isKeyframe(segment(trun(TRUN_DATA_OFFSET | TRUN_FIRST_SAMPLE_FLAGS, 1, [ 0, 0x02000000 ])))).toBe(true);
    expect(isKeyframe(segment(trun(TRUN_DATA_OFFSET | TRUN_FIRST_SAMPLE_FLAGS, 1, [ 0, SAMPLE_NON_SYNC ])))).toBe(false);
  });

  it('falls back to per-sample flags, skipping duration and size fields', () => {

    const flags = TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS;

    expect(isKeyframe(segment(trun(flags, 1, [ 1000, 512, 0 ])))).toBe(true);
    expect(isKeyframe(segment(trun(flags, 1, [ 1000, 512, SAMPLE_NON_SYNC ])))).toBe(false);
  });

  it('returns false when the box hierarchy or flags are missing', () => {

    expect(isKeyframe(Buffer.alloc(16))).toBe(false);
    expect(isKeyframe(segment(trun(0, 1, [])))).toBe(false);
    expect(isKeyframe(box('moof', Buffer.alloc(4)))).toBe(false);
  });
});

describe('hasAudioTrack', () => {

  it('detects audio handlers across multiple tracks', () => {

    const videoTrak = box('trak', box('mdia', hdlr('vide')));
    const audioTrak = box('trak', box('mdia', hdlr('soun')));

    expect(hasAudioTrack(box('moov', Buffer.concat([ videoTrak, audioTrak ])))).toBe(true);
    expect(hasAudioTrack(box('moov', videoTrak))).toBe(false);
    expect(hasAudioTrack(Buffer.alloc(8))).toBe(false);
  });
});

describe('splitMoofMdat', () => {

  it('splits a fragment into its moof and mdat boxes', () => {

    const moofBox = box('moof', box('traf', trun(TRUN_FIRST_SAMPLE_FLAGS, 1, [ 0x02000000 ])));
    const mdatBox = box('mdat', Buffer.from('framedata'));

    const result = splitMoofMdat(Buffer.concat([ moofBox, mdatBox ]));

    expect(result).not.toBeNull();
    expect(result?.moof).toEqual(moofBox);
    expect(result?.mdat).toEqual(mdatBox);
  });

  it('returns null when the mdat box is missing', () => {

    expect(splitMoofMdat(box('moof', Buffer.alloc(4)))).toBeNull();
    expect(splitMoofMdat(Buffer.alloc(0))).toBeNull();
  });
});
