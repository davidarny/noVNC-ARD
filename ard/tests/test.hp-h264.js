/*
 * Unit tests for the H.264 helpers of High Performance mode. Every byte here
 * is synthetic.
 *
 * Run: node --test ard/tests/test.hp-h264.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import {
    isParameterPacket, parseParameterPacket, codecFromAnnexB, DEFAULT_CODEC,
    spsWithoutReordering, withoutReordering,
} from '../hp/h264.js';

function concat(...chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

function u16(v) {
    return [(v >> 8) & 0xff, v & 0xff];
}

function box(type, ...content) {
    const body = concat(...content);
    const size = 8 + body.length;
    return concat([size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff],
                  Array.from(type, c => c.charCodeAt(0)), body);
}

const SPS = Uint8Array.of(0x27, 0x64, 0x00, 0x34, 0xac, 0x13);
const PPS = Uint8Array.of(0x28, 0xee, 0x1f, 0x2c);

function record(spsList, ppsList) {
    return concat([1, 0x64, 0x00, 0x34, 0xff, 0xe0 | spsList.length],
                  ...spsList.flatMap(s => [u16(s.length), s]),
                  [ppsList.length],
                  ...ppsList.flatMap(s => [u16(s.length), s]));
}

// prefix, then 'avc1' { 78 bytes of fixed fields, child boxes }
function packet(...children) {
    return concat([0x92, 0xe6, 0xc0, 0xa3], box('avc1', new Uint8Array(78), ...children));
}

describe('H.264 parameter packet', () => {
    it('reads the SPS and PPS from the avcC box', () => {
        const p = packet(box('avcC', record([SPS], [PPS])));
        strictEqual(isParameterPacket(p), true);
        deepStrictEqual(parseParameterPacket(p), [SPS, PPS]);
    });

    it('finds avcC among other boxes, in any position', () => {
        const colr = box('colr', Array.from('nclc', c => c.charCodeAt(0)), [0, 12, 0, 13, 0, 1]);
        const pasp = box('pasp', [0, 0, 0, 1, 0, 0, 0, 1]);
        const avcC = box('avcC', record([SPS], [PPS]));
        deepStrictEqual(parseParameterPacket(packet(avcC, colr, pasp)), [SPS, PPS]);
        deepStrictEqual(parseParameterPacket(packet(colr, pasp, avcC)), [SPS, PPS]);
    });

    it('ignores bytes after the sample entry', () => {
        const p = concat(packet(box('avcC', record([SPS], [PPS]))), [0, 0, 0, 0]);
        deepStrictEqual(parseParameterPacket(p), [SPS, PPS]);
    });

    it('returns several parameter sets in order', () => {
        const sps2 = Uint8Array.of(0x27, 0x42, 0x00, 0x1f);
        const pps2 = Uint8Array.of(0x28, 0xce);
        const p = packet(box('avcC', record([SPS, sps2], [PPS, pps2])));
        deepStrictEqual(parseParameterPacket(p), [SPS, sps2, PPS, pps2]);
    });

    it('does not take NAL unit data for a parameter packet', () => {
        const fragment = Uint8Array.of(0x3d, 0x85, 0x00, 0x01, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80);
        strictEqual(isParameterPacket(fragment), false);
        strictEqual(parseParameterPacket(fragment), null);
        strictEqual(isParameterPacket(new Uint8Array(3)), false);
    });

    it('returns null for a damaged packet', () => {
        const good = packet(box('avcC', record([SPS], [PPS])));
        for (let cut = 13; cut < good.length; cut++) {
            strictEqual(parseParameterPacket(good.subarray(0, cut)), null, 'cut at ' + cut);
        }
        strictEqual(parseParameterPacket(packet()), null, 'no avcC');
        strictEqual(parseParameterPacket(packet(box('avcC', record([], [])))), null, 'no sets');
        strictEqual(parseParameterPacket(packet(box('avcC', [2, 0x64, 0, 0x34, 0xff, 0xe0, 0]))), null, 'version');

        const zeroSize = packet(box('avcC', record([SPS], [PPS])));
        zeroSize.set([0, 0, 0, 0], 4 + 8 + 78);     // child box of size 0 must not loop
        strictEqual(parseParameterPacket(zeroSize), null);
    });
});

describe('H.264 codec string', () => {
    it('is built from the profile, constraint and level bytes of the SPS', () => {
        const data = concat([0, 0, 0, 1], SPS, [0, 0, 0, 1], PPS, [0, 0, 0, 1], [0x25, 0x88, 0x80]);
        strictEqual(codecFromAnnexB(data), 'avc1.640034');
        strictEqual(codecFromAnnexB(concat([0, 0, 1], [0x67, 0x42, 0xc0, 0x1f])), 'avc1.42c01f');
    });

    it('is null without an SPS', () => {
        strictEqual(codecFromAnnexB(concat([0, 0, 0, 1], [0x25, 0x88, 0x80, 0x10])), null);
        strictEqual(codecFromAnnexB(new Uint8Array(0)), null);
    });

    it('has a default for the streams seen so far', () => {
        strictEqual(DEFAULT_CODEC, 'avc1.640034');
    });
});

// --- SPS rewriting ---

// Bit string builder: the tests write an SPS field by field, twice, once as
// a server would send it and once as the viewer should hand it on.
class Bits {
    constructor() { this.s = ''; }
    u(v, n) { this.s += v.toString(2).padStart(n, '0'); return this; }
    ue(v) { const b = (v + 1).toString(2); this.s += '0'.repeat(b.length - 1) + b; return this; }
    // Stop bit, pad to a byte, insert emulation prevention
    nal() {
        let s = this.s + '1';
        s += '0'.repeat((8 - s.length % 8) % 8);
        const out = [];
        let zeros = 0;
        for (let i = 0; i < s.length; i += 8) {
            const b = parseInt(s.slice(i, i + 8), 2);
            if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
            out.push(b);
            zeros = b === 0 ? zeros + 1 : 0;
        }
        return Uint8Array.from(out);
    }
}

// Everything before vui_parameters_present_flag
function spsHead({ profile = 100, refFrames = 12, width = 239 } = {}) {
    const b = new Bits().u(0x27, 8).u(profile, 8).u(0, 8).u(52, 8).ue(0);
    if (profile === 100) b.ue(1).ue(0).ue(0).u(0, 1).u(0, 1);
    return b.ue(8).ue(0).ue(10)                 // frame_num bits, POC type 0 and its bits
        .ue(refFrames).u(0, 1).ue(width).ue(33)
        .u(1, 1).u(1, 1).u(0, 1);               // frame_mbs_only, direct_8x8, no cropping
}

// A VUI as the Intel server sends it, up to bitstream_restriction_flag
function vuiHead(b) {
    return b.u(1, 1)                            // vui_parameters_present_flag
        .u(1, 1).u(0, 8)                        // aspect ratio: unspecified
        .u(0, 1)                                // no overscan info
        .u(1, 1).u(5, 3).u(1, 1).u(1, 1).u(12, 8).u(2, 8).u(1, 8)
        .u(1, 1).ue(0).ue(0)                    // chroma location
        .u(0, 1)                                // no timing
        .u(1, 1).ue(0).u(0, 4).u(3, 4).ue(11999).ue(5999).u(0, 1).u(23, 5).u(23, 5).u(23, 5).u(24, 5)
        .u(0, 1)                                // no VCL HRD
        .u(0, 1)                                // low_delay_hrd_flag
        .u(1, 1);                               // pic_struct_present_flag
}

function restriction(b, reorder, buffering) {
    return b.u(1, 1).u(1, 1).ue(2).ue(1).ue(16).ue(16).ue(reorder).ue(buffering);
}

describe('H.264 SPS without reordering', () => {
    it('adds a bitstream restriction to a VUI that has none', () => {
        const before = vuiHead(spsHead()).u(0, 1).nal();
        const after = restriction(vuiHead(spsHead()), 0, 12).nal();
        deepStrictEqual(spsWithoutReordering(before), after);
    });

    it('adds a VUI to an SPS that has none', () => {
        for (const profile of [100, 66]) {
            const before = spsHead({ profile, refFrames: 4 }).u(0, 1).nal();
            const after = restriction(spsHead({ profile, refFrames: 4 }).u(1, 1).u(0, 8), 0, 4).nal();
            deepStrictEqual(spsWithoutReordering(before), after, 'profile ' + profile);
        }
    });

    it('never states a picture buffer of zero', () => {
        const before = spsHead({ refFrames: 0 }).u(0, 1).nal();
        const after = restriction(spsHead({ refFrames: 0 }).u(1, 1).u(0, 8), 0, 1).nal();
        deepStrictEqual(spsWithoutReordering(before), after);
    });

    it('leaves an SPS that already has a restriction, whatever it says', () => {
        for (const reorder of [0, 2]) {
            const sps = restriction(vuiHead(spsHead()), reorder, 12).nal();
            strictEqual(spsWithoutReordering(sps), sps);
        }
    });

    it('gives the same result when applied twice', () => {
        const once = spsWithoutReordering(vuiHead(spsHead()).u(0, 1).nal());
        strictEqual(spsWithoutReordering(once), once);
    });

    it('reads and writes emulation prevention bytes', () => {
        // a width whose code holds 32 zero bits in a row, so three zero
        // bytes wherever it falls: the SPS needs a 03
        const width = 2 ** 32 - 1;
        const before = spsHead({ width }).u(0, 1).nal();
        const after = restriction(spsHead({ width }).u(1, 1).u(0, 8), 0, 12).nal();
        const hasPrevention = bytes => bytes.some((b, i) => i >= 2 && b === 3 && !bytes[i - 1] && !bytes[i - 2]);
        ok(hasPrevention(before), 'the test SPS has one');
        deepStrictEqual(spsWithoutReordering(before), after);
        ok(hasPrevention(spsWithoutReordering(before)));
    });

    it('returns what it cannot read unchanged', () => {
        const good = vuiHead(spsHead()).u(0, 1).nal();
        for (let cut = 0; cut < good.length - 1; cut++) {
            const part = good.subarray(0, cut);
            strictEqual(spsWithoutReordering(part), part, 'cut at ' + cut);
        }
        const zeros = new Uint8Array(40);
        strictEqual(spsWithoutReordering(zeros), zeros);
        ok(spsWithoutReordering(new Uint8Array(40).fill(0xff)) instanceof Uint8Array);
    });
});

describe('H.264 picture without reordering', () => {
    const start = [0, 0, 0, 1];
    const pps = [0x28, 0xee, 0x1f, 0x2c];
    const slice = [0x25, 0x88, 0x80, 0x40, 0x00, 0x00, 0x03, 0x00, 0x10];

    it('replaces the SPS and keeps every other unit byte for byte', () => {
        const before = vuiHead(spsHead()).u(0, 1).nal();
        const after = restriction(vuiHead(spsHead()), 0, 12).nal();
        deepStrictEqual(withoutReordering(concat(start, before, start, pps, start, slice)),
                        concat(start, after, start, pps, start, slice));
    });

    it('returns a picture without an SPS as it is', () => {
        const data = concat(start, slice);
        strictEqual(withoutReordering(data), data);
        const empty = new Uint8Array(0);
        strictEqual(withoutReordering(empty), empty);
    });
});
