/*
 * High Performance mode — the little H.264 knowledge the viewer needs: the
 * packet that carries a stream's parameter sets, and naming the stream for
 * WebCodecs.
 *
 * An Intel server sends H.264 where an Apple silicon server sends HEVC
 * (ARD protocol spec, Section 14.10.1).
 */

import { splitAnnexB } from './hevc.js';

export const NAL_IDR = 5;
export const NAL_SPS = 7;

// Codec string of the streams observed so far: High profile, level 5.2.
// Used when a stream's own SPS cannot be read.
export const DEFAULT_CODEC = 'avc1.640034';

export function nalType(nal) {
    return nal[0] & 0x1f;
}

const PREFIX = 4;               // four bytes of unknown meaning before the sample entry
const BOX_HEADER = 8;           // size, type
const VISUAL_ENTRY_FIELDS = 78; // fixed part of a visual sample entry after its header

function u32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function isType(bytes, offset, type) {
    for (let i = 0; i < 4; i++) {
        if (bytes[offset + i] !== type.charCodeAt(i)) return false;
    }
    return true;
}

// Whether an RTP payload is the parameter packet and not NAL unit data.
export function isParameterPacket(p) {
    return p.length >= PREFIX + BOX_HEADER && isType(p, PREFIX + 4, 'avc1');
}

// The SPS and PPS units of an AVC decoder configuration record, in order.
function parameterSets(record) {
    if (record.length < 7 || record[0] !== 1) return null;
    const units = [];
    let o = 5;
    for (const mask of [0x1f, 0xff]) {
        if (o >= record.length) return null;
        let count = record[o++] & mask;
        while (count-- > 0) {
            if (o + 2 > record.length) return null;
            const size = (record[o] << 8) | record[o + 1];
            o += 2;
            if (size === 0 || o + size > record.length) return null;
            units.push(record.subarray(o, o + size));
            o += size;
        }
    }
    return units.length ? units : null;
}

/*
 * The first packet of each stream: four bytes, then an 'avc1' sample entry
 * as in an MP4 file, whose 'avcC' box holds the parameter sets. Returns the
 * SPS and PPS units, or null when the packet is not one of these.
 */
export function parseParameterPacket(p) {
    if (!isParameterPacket(p)) return null;
    const end = Math.min(p.length, PREFIX + u32(p, PREFIX));
    let o = PREFIX + BOX_HEADER + VISUAL_ENTRY_FIELDS;
    while (o + BOX_HEADER <= end) {
        const size = u32(p, o);
        if (size < BOX_HEADER || o + size > end) return null;
        if (isType(p, o + 4, 'avcC')) {
            return parameterSets(p.subarray(o + BOX_HEADER, o + size));
        }
        o += size;
    }
    return null;
}

function hex2(v) {
    return v.toString(16).padStart(2, '0');
}

/*
 * The WebCodecs codec string ("avc1.PPCCLL") for a stream, from the profile,
 * constraint flags and level in its SPS. Returns null when the buffer holds
 * no SPS.
 */
export function codecFromAnnexB(data) {
    const sps = splitAnnexB(data).find(nal => nal.length >= 4 && nalType(nal) === NAL_SPS);
    if (!sps) return null;
    return 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
}

// ----- decoding without delay -----

/*
 * A decoder may hold pictures back for as long as the stream could still
 * reorder them. These streams never reorder, but their SPS does not say so
 * (no bitstream restriction in the VUI), so a decoder that goes by the book
 * holds a full picture buffer: the screen would run sixteen pictures behind
 * and its last change would not show until something else moved. The SPS is
 * therefore given the missing statement before the decoder sees it.
 */

// Profiles whose SPS has the chroma format and scaling matrix fields.
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// Remove emulation prevention bytes (00 00 03 → 00 00).
function unescape(nal) {
    const out = new Uint8Array(nal.length);
    let n = 0, zeros = 0;
    for (const b of nal) {
        if (zeros >= 2 && b === 3) {
            zeros = 0;
            continue;
        }
        out[n++] = b;
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
}

// Put them back: after two zero bytes, a byte of 3 or less needs one.
function escape(rbsp) {
    const out = [];
    let zeros = 0;
    for (const b of rbsp) {
        if (zeros >= 2 && b <= 3) {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(out);
}

class BitReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.pos = 0;           // in bits
    }

    bit() {
        if (this.pos >= this.bytes.length * 8) throw new RangeError('SPS: truncated');
        const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return b;
    }

    bits(n) {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 2 + this.bit();
        return v;
    }

    ue() {
        let zeros = 0;
        while (this.bit() === 0) {
            if (++zeros > 32) throw new RangeError('SPS: bad exp-Golomb code');
        }
        return 2 ** zeros - 1 + this.bits(zeros);
    }

    se() {
        const v = this.ue();
        return v & 1 ? (v + 1) / 2 : -v / 2;
    }
}

class BitWriter {
    constructor() {
        this.out = [];
        this.count = 0;
    }

    bit(b) {
        if ((this.count & 7) === 0) this.out.push(0);
        if (b) this.out[this.out.length - 1] |= 0x80 >> (this.count & 7);
        this.count++;
    }

    bits(v, n) {
        for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
    }

    ue(v) {
        const n = Math.floor(Math.log2(v + 1));
        this.bits(0, n);
        this.bits(v + 1, n + 1);
    }
}

function skipScalingList(r, size) {
    let last = 8, next = 8;
    for (let i = 0; i < size; i++) {
        if (next !== 0) next = (last + r.se() + 256) % 256;
        last = next === 0 ? last : next;
    }
}

function skipHrd(r) {
    const count = r.ue() + 1;
    if (count > 32) throw new RangeError('SPS: bad HRD');
    r.bits(8);
    for (let i = 0; i < count; i++) {
        r.ue();
        r.ue();
        r.bit();
    }
    r.bits(20);
}

/*
 * Read an SPS (emulation prevention removed, NAL header included) as far as
 * the question matters: where the VUI's flags are and what they say.
 * Returns { refFrames, vuiFlagAt, restrictionFlagAt, reorderFrames }; a
 * position is null when the SPS does not get that far.
 */
function readSps(rbsp) {
    const r = new BitReader(rbsp);
    r.bits(8);                                  // NAL header
    const profile = r.bits(8);
    r.bits(16);                                 // constraint flags, level
    r.ue();                                     // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
        const chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue();
        r.ue();
        r.bit();
        if (r.bit()) {
            for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
            }
        }
    }
    r.ue();                                     // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
        r.ue();
    } else if (pocType === 1) {
        r.bit();
        r.se();
        r.se();
        const cycle = r.ue();
        if (cycle > 255) throw new RangeError('SPS: bad picture order cycle');
        for (let i = 0; i < cycle; i++) r.se();
    }
    const refFrames = r.ue();
    r.bit();
    r.ue();                                     // width
    r.ue();                                     // height
    if (!r.bit()) r.bit();                      // frame_mbs_only_flag
    r.bit();
    if (r.bit()) {                              // frame cropping
        for (let i = 0; i < 4; i++) r.ue();
    }

    const sps = { refFrames, vuiFlagAt: r.pos, restrictionFlagAt: null, reorderFrames: null };
    if (!r.bit()) return sps;

    if (r.bit() && r.bits(8) === 255) r.bits(32);       // aspect ratio
    if (r.bit()) r.bit();                               // overscan
    if (r.bit()) {                                      // video signal type
        r.bits(4);
        if (r.bit()) r.bits(24);
    }
    if (r.bit()) {                                      // chroma location
        r.ue();
        r.ue();
    }
    if (r.bit()) r.bits(65);                            // timing
    const nalHrd = r.bit();
    if (nalHrd) skipHrd(r);
    const vclHrd = r.bit();
    if (vclHrd) skipHrd(r);
    if (nalHrd || vclHrd) r.bit();
    r.bit();                                            // pic_struct_present_flag

    sps.restrictionFlagAt = r.pos;
    if (r.bit()) {
        r.bit();
        for (let i = 0; i < 4; i++) r.ue();
        sps.reorderFrames = r.ue();
    }
    return sps;
}

/*
 * The SPS with a statement that its pictures come out in the order they go
 * in. Returned unchanged when it already has a bitstream restriction, or
 * cannot be read.
 */
export function spsWithoutReordering(nal) {
    const rbsp = unescape(nal);
    let sps;
    try {
        sps = readSps(rbsp);
    } catch (e) {
        return nal;
    }
    if (sps.reorderFrames !== null) return nal;

    const w = new BitWriter();
    const r = new BitReader(rbsp);
    const keep = sps.restrictionFlagAt === null ? sps.vuiFlagAt : sps.restrictionFlagAt;
    for (let i = 0; i < keep; i++) w.bit(r.bit());
    if (sps.restrictionFlagAt === null) {
        // No VUI at all: one with nothing in it but the restriction
        w.bit(1);
        w.bits(0, 8);
    }
    w.bit(1);                                   // bitstream_restriction_flag
    w.bit(1);                                   // motion vectors may cross picture boundaries
    w.ue(2);                                    // max_bytes_per_pic_denom, the default
    w.ue(1);                                    // max_bits_per_mb_denom, the default
    w.ue(16);                                   // log2_max_mv_length_horizontal, the default
    w.ue(16);                                   // log2_max_mv_length_vertical, the default
    w.ue(0);                                    // max_num_reorder_frames
    w.ue(Math.max(1, sps.refFrames));           // max_dec_frame_buffering
    w.bit(1);                                   // stop bit; the rest of the byte stays 0
    return escape(w.out);
}

// An Annex B picture with every SPS in it replaced as above. Pictures
// without an SPS, nearly all of them, are returned as they are.
export function withoutReordering(data) {
    // Parameter sets come first, so an SPS is the first unit or absent
    if (data.length < 5 || data[0] || data[1] || data[2] !== 0 || data[3] !== 1 ||
        nalType(data.subarray(4)) !== NAL_SPS) {
        return data;
    }
    const units = splitAnnexB(data).map(nal => (nalType(nal) === NAL_SPS ? spsWithoutReordering(nal) : nal));
    const out = new Uint8Array(units.reduce((n, unit) => n + 4 + unit.length, 0));
    let o = 0;
    for (const unit of units) {
        out[o + 3] = 1;
        out.set(unit, o + 4);
        o += 4 + unit.length;
    }
    return out;
}
