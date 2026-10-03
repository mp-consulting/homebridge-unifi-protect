/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * fmp4.ts: ISO BMFF (fMP4) box parsing utilities.
 */

/**
 * ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.
 *
 * This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4
 * (fMP4) streams. It enables locating specific box types, splitting fragments into their moof/mdat components, detecting keyframe (sync sample) segments by
 * parsing the TRUN sample flags, and identifying audio track presence in initialization segments.
 *
 * These utilities are independent of FFmpeg processes or streaming pipelines. The inspection helpers operate on complete Buffers, while `FMp4BoxReader`
 * incrementally reassembles top-level boxes from a chunked byte stream.
 *
 * @module
 */
import type { Nullable } from '../util.js';

/**
 * ISO BMFF box header size in bytes: 4 bytes big-endian size + 4 bytes ASCII type.
 *
 * @category FFmpeg
 */
export const BOX_HEADER_SIZE = 8;

/**
 * ISO BMFF "mdat" box type encoded as a 32-bit integer, for comparison without string allocation in box-parsing hot paths.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MDAT = 0x6D646174;

/**
 * ISO BMFF "moof" box type encoded as a 32-bit integer.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MOOF = 0x6D6F6F66;

/**
 * ISO BMFF "moov" box type encoded as a 32-bit integer.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MOOV = 0x6D6F6F76;

// TRUN fullbox header size: standard box header + 4 bytes version/flags + 4 bytes sample_count.
const TRUN_HEADER_SIZE = BOX_HEADER_SIZE + 8;

// TRUN box flags indicating the presence of optional fields.
const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;
const TRUN_FLAG_SAMPLE_SIZE = 0x000200;
const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;

// Sample flags bit indicating a non-sync sample. When this bit is clear (0), the sample is a sync sample (keyframe/IDR).
const SAMPLE_FLAG_NON_SYNC = 0x00010000;

// Handler type for audio tracks in ISO BMFF: "soun" encoded as a 32-bit integer.
const HDLR_TYPE_SOUN = 0x736F756E;

// Offset from the start of an hdlr fullbox to the handler_type field: standard box header (8 bytes) + version/flags (4 bytes) + pre_defined (4 bytes).
const HDLR_TYPE_OFFSET = BOX_HEADER_SIZE + 8;

/**
 * Describes the location of an ISO BMFF box within a buffer.
 *
 * @property offset    - The byte offset of the box start (including the header).
 * @property size      - The total box size in bytes (including the header).
 *
 * @category FFmpeg
 */
export interface FMp4Box {

  offset: number;
  size: number;
}

/**
 * Locates the first ISO BMFF box of a given type within a byte range.
 *
 * Walks the standard box headers (4-byte big-endian size + 4-byte ASCII type) starting at `start` and ending at `end`. Returns the offset and size of the first
 * matching box, or `null` if no match is found. Does not handle extended-size boxes (64-bit size field) as these are uncommon in fMP4 livestream contexts.
 *
 * @param buffer       - The buffer containing ISO BMFF box data.
 * @param type         - The 4-character ASCII box type to search for (e.g. "moof", "traf", "trun"). Must be exactly 4 characters.
 * @param start        - Optional. The byte offset to begin searching from. Defaults to 0.
 * @param end          - Optional. The byte offset to stop searching at. Defaults to the buffer length.
 *
 * @returns The box location, or `null` if not found.
 *
 * @category FFmpeg
 */
export function findBox(buffer: Buffer, type: string, start = 0, end?: number): Nullable<FMp4Box> {

  const limit = end ?? buffer.length;

  // Encode the target type as a 32-bit integer for comparison, avoiding string allocation on every box visited. Box types in ISO BMFF are always exactly 4
  // ASCII bytes.
  if(type.length !== 4) {

    return null;
  }

  const target = ((type.charCodeAt(0) << 24) | (type.charCodeAt(1) << 16) | (type.charCodeAt(2) << 8) | type.charCodeAt(3)) >>> 0;

  let offset = start;

  // Walk boxes by reading each header: 4 bytes size (big-endian) + 4 bytes type.
  while((offset + BOX_HEADER_SIZE) <= limit) {

    const size = buffer.readUInt32BE(offset);

    // A valid box must be at least the header size and must not extend beyond the search range. Size values below the header size indicate corruption,
    // misalignment, extended-size boxes (size === 1), or open-ended boxes (size === 0) - none of which are supported in this context.
    if((size < BOX_HEADER_SIZE) || (size > (limit - offset))) {

      return null;
    }

    // Compare the box type as a 32-bit integer to avoid allocating a string on every iteration.
    if(buffer.readUInt32BE(offset + 4) === target) {

      return { offset, size };
    }

    // Advance to the next box.
    offset += size;
  }

  return null;
}

/**
 * Determines whether an fMP4 segment contains a keyframe (sync sample) by parsing the TRUN sample flags.
 *
 * Traverses the box hierarchy `moof -> traf -> trun` and inspects the sample flags to determine if the first sample is a sync sample (keyframe/IDR frame).
 * Checks `first_sample_flags` first (the common case for fragments generated with `frag_keyframe`), then falls back to per-sample flags if available. Returns
 * `false` if the box structure cannot be parsed or if the flags indicate a non-sync sample.
 *
 * @param segment      - A buffer containing a complete fMP4 segment (typically a moof+mdat pair).
 *
 * @returns `true` if the segment's first sample is a sync sample (keyframe), `false` otherwise.
 *
 * @category FFmpeg
 */
export function isKeyframe(segment: Buffer): boolean {

  // Locate the moof box at the top level.
  const moof = findBox(segment, 'moof');

  if(!moof) {

    return false;
  }

  // Locate the traf box inside the moof. Child boxes start after the parent's header.
  const traf = findBox(segment, 'traf', moof.offset + BOX_HEADER_SIZE, moof.offset + moof.size);

  if(!traf) {

    return false;
  }

  // Locate the trun box inside the traf.
  const trun = findBox(segment, 'trun', traf.offset + BOX_HEADER_SIZE, traf.offset + traf.size);

  if(!trun) {

    return false;
  }

  // The trun is a fullbox: after the standard box header come 4 bytes of version/flags and 4 bytes of sample_count. We need the full header to read the flags
  // and determine which optional fields follow.
  if(trun.size < TRUN_HEADER_SIZE) {

    return false;
  }

  // Read the flags from the fullbox header. The version occupies the top byte and the flags occupy the lower 24 bits.
  const flags = segment.readUInt32BE(trun.offset + BOX_HEADER_SIZE) & 0x00FFFFFF;

  // Start after the trun header (box header + version/flags + sample_count).
  let pos = trun.offset + TRUN_HEADER_SIZE;

  // Skip the optional data_offset field if present.
  if(flags & TRUN_FLAG_DATA_OFFSET) {

    pos += 4;
  }

  // Check first_sample_flags if present. This is the most common path for fMP4 fragments generated with the frag_keyframe movflag, where each fragment starts
  // at a keyframe and the first sample's flags are stored separately from the per-sample entries.
  if(flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) {

    if((pos + 4) > (trun.offset + trun.size)) {

      return false;
    }

    return (segment.readUInt32BE(pos) & SAMPLE_FLAG_NON_SYNC) === 0;
  }

  // Fall back to per-sample flags. The per-sample entry fields appear in a fixed order: duration, size, flags, composition time offset. We skip duration and
  // size to reach the first sample's flags field.
  if(flags & TRUN_FLAG_SAMPLE_FLAGS) {

    if(flags & TRUN_FLAG_SAMPLE_DURATION) {

      pos += 4;
    }

    if(flags & TRUN_FLAG_SAMPLE_SIZE) {

      pos += 4;
    }

    if((pos + 4) > (trun.offset + trun.size)) {

      return false;
    }

    return (segment.readUInt32BE(pos) & SAMPLE_FLAG_NON_SYNC) === 0;
  }

  // No sample flags information available in the trun...we can't determine keyframe status.
  return false;
}

/**
 * Determines whether an fMP4 initialization segment contains an audio track by inspecting the handler type in each track's media handler box.
 *
 * Traverses the box hierarchy `moov -> trak -> mdia -> hdlr` for every track in the init segment and checks the handler_type field for "soun" (0x736F756E).
 * This is the standard ISO BMFF mechanism for identifying track media types - "soun" for audio, "vide" for video, "subt" for subtitles, etc.
 *
 * @param initSegment   - A buffer containing a complete fMP4 initialization segment (typically ftyp + moov).
 *
 * @returns `true` if the init segment contains at least one audio track, `false` otherwise.
 *
 * @category FFmpeg
 */
export function hasAudioTrack(initSegment: Buffer): boolean {

  // Locate the moov box at the top level.
  const moov = findBox(initSegment, 'moov');

  if(!moov) {

    return false;
  }

  const moovStart = moov.offset + BOX_HEADER_SIZE;
  const moovEnd = moov.offset + moov.size;

  // Walk each trak box inside the moov, advancing past each one we find. Once we've passed the last trak, findBox runs out of range and returns null, which is
  // how we know we're done.
  let trakStart = moovStart;

  for(;;) {

    const trak = findBox(initSegment, 'trak', trakStart, moovEnd);

    if(!trak) {

      return false;
    }

    // Locate the mdia box inside this trak.
    const mdia = findBox(initSegment, 'mdia', trak.offset + BOX_HEADER_SIZE, trak.offset + trak.size);

    if(mdia) {

      // Locate the hdlr box inside the mdia.
      const hdlr = findBox(initSegment, 'hdlr', mdia.offset + BOX_HEADER_SIZE, mdia.offset + mdia.size);

      // Read the handler_type field. In a hdlr fullbox, the layout after the standard box header is: version/flags (4 bytes) + pre_defined (4 bytes) +
      // handler_type (4 bytes). We check that the box is large enough to contain the field before reading.
      if(hdlr && (hdlr.size >= (HDLR_TYPE_OFFSET + 4))) {

        if(initSegment.readUInt32BE(hdlr.offset + HDLR_TYPE_OFFSET) === HDLR_TYPE_SOUN) {

          return true;
        }
      }
    }

    // Advance past this trak to search for the next one.
    trakStart = trak.offset + trak.size;
  }
}

/**
 * Splits an fMP4 fragment into its moof and mdat components.
 *
 * Locates the `mdat` box and returns everything before it as the moof portion (which includes the moof box and any preceding metadata boxes) and everything
 * from the mdat box to the end of the fragment as the mdat portion. The returned buffers are subarray views into the original buffer, so no data is copied.
 * Returns `null` if the mdat box cannot be found.
 *
 * @param fragment     - A buffer containing a complete fMP4 fragment.
 *
 * @returns An object with `moof` and `mdat` sub-buffers, or `null` if the structure cannot be parsed.
 *
 * @category FFmpeg
 */
export function splitMoofMdat(fragment: Buffer): Nullable<{ mdat: Buffer, moof: Buffer }> {

  const mdat = findBox(fragment, 'mdat');

  if(!mdat) {

    return null;
  }

  return { mdat: fragment.subarray(mdat.offset), moof: fragment.subarray(0, mdat.offset) };
}

/**
 * A complete ISO BMFF box parsed from a byte stream by {@link FMp4BoxReader}.
 *
 * @property data      - The box payload, excluding the header.
 * @property header    - The 8-byte box header.
 * @property length    - The payload length in bytes (the box size minus the header size).
 * @property type      - The 4-character box type encoded as a 32-bit big-endian integer.
 *
 * @category FFmpeg
 */
export interface FMp4ParsedBox {

  data: Buffer;
  header: Buffer;
  length: number;
  type: number;
}

/**
 * Incremental ISO BMFF box reader for chunked byte streams such as FFmpeg's stdout.
 *
 * Chunks are fed in via {@link FMp4BoxReader.push} and every complete top-level box is handed to the callback in order. Boxes may be split across chunks at any
 * offset, including inside the 8-byte header. Partial data is collected in an array with a running length and concatenated exactly once when the box it
 * belongs to is complete, keeping reassembly linear in the box size rather than quadratic in the number of chunks.
 *
 * Box sizes smaller than the header size (zero-size, open-ended, or extended-size boxes) are treated as fatal stream corruption: `push()` returns `false`,
 * `invalidBoxSize` records the offending size, and the reader discards its pending data.
 *
 * @category FFmpeg
 */
export class FMp4BoxReader {

  /**
   * The offending box size from the most recent corrupt box, or `null` if no corruption has been detected.
   */
  public invalidBoxSize: Nullable<number>;

  // Size of the box currently being reassembled, or 0 when we don't yet have a complete header for it.
  private boxSize: number;
  private pending: Buffer[];
  private pendingLength: number;

  constructor() {

    this.boxSize = 0;
    this.invalidBoxSize = null;
    this.pending = [];
    this.pendingLength = 0;
  }

  /**
   * Feeds a chunk of bytes into the reader, invoking `onBox` for every box completed by it.
   *
   * @param chunk      - The next chunk of the byte stream.
   * @param onBox      - Callback invoked synchronously for each complete box, in stream order.
   *
   * @returns `true` if the stream remains parseable, `false` if a corrupt box size was encountered.
   */
  public push(chunk: Buffer, onBox: (box: FMp4ParsedBox) => void): boolean {

    // Nothing pending - parse the chunk directly without copying it.
    if(!this.pendingLength) {

      return this.parse(chunk, onBox);
    }

    this.pending.push(chunk);
    this.pendingLength += chunk.length;

    // We know the size of the box we're reassembling and still don't have all of it. Keep collecting without copying.
    if(this.boxSize && (this.pendingLength < this.boxSize)) {

      return true;
    }

    // Either the pending box is now complete, or we were waiting on a split header. In both cases a single concatenation gives us a contiguous buffer to parse.
    // For a split header, the pending bytes are fewer than the header size, so the copy is bounded by the size of this chunk.
    const buffer = Buffer.concat(this.pending, this.pendingLength);

    this.reset();

    return this.parse(buffer, onBox);
  }

  /**
   * Discards any partially received box data and clears the corruption state.
   */
  public reset(): void {

    this.boxSize = 0;
    this.invalidBoxSize = null;
    this.pending = [];
    this.pendingLength = 0;
  }

  // Walk the complete boxes in a contiguous buffer, stashing any trailing partial box for the next chunk.
  private parse(buffer: Buffer, onBox: (box: FMp4ParsedBox) => void): boolean {

    let offset = 0;

    for(;;) {

      const remaining = buffer.length - offset;

      // We've consumed the buffer exactly.
      if(!remaining) {

        return true;
      }

      // Not enough bytes for a complete box header. Save them for the next chunk.
      if(remaining < BOX_HEADER_SIZE) {

        this.stash(buffer.subarray(offset), 0);

        return true;
      }

      // The first four bytes represent the length of the entire box, including the header.
      const size = buffer.readUInt32BE(offset);

      // A valid box must be at least the header size. Anything smaller would leave us unable to advance, so we treat the stream as fatally corrupt.
      if(size < BOX_HEADER_SIZE) {

        this.reset();
        this.invalidBoxSize = size;

        return false;
      }

      // We don't have the whole box yet. Save what we have along with the size we're waiting for.
      if(remaining < size) {

        this.stash(buffer.subarray(offset), size);

        return true;
      }

      onBox({

        data: buffer.subarray(offset + BOX_HEADER_SIZE, offset + size),
        header: buffer.subarray(offset, offset + BOX_HEADER_SIZE),
        length: size - BOX_HEADER_SIZE,
        type: buffer.readUInt32BE(offset + 4),
      });

      offset += size;
    }
  }

  // Save a partial box to be completed by subsequent chunks.
  private stash(partial: Buffer, boxSize: number): void {

    this.boxSize = boxSize;
    this.pending = [ partial ];
    this.pendingLength = partial.length;
  }
}
