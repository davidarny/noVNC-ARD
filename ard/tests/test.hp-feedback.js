/*
 * Unit tests for the high-performance RTCP feedback builders
 *
 * Run: node --test ard/tests/test.hp-feedback.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import { receiverReport, pictureAck, rateControl } from '../hp/feedback.js';

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g);
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// Helper: Uint8Array → hex string (for readable assertion messages)
function toHex(arr) {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function u16(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

// Walk a compound packet, checking each RTCP length field (words − 1)
// against the bytes that are actually there. Returns the packet types.
function packetTypes(bytes) {
    const types = [];
    let offset = 0;
    while (offset < bytes.length) {
        ok(offset + 4 <= bytes.length, 'truncated RTCP header');
        strictEqual(bytes[offset] >> 6, 2, 'RTP version');
        const size = (u16(bytes, offset + 2) + 1) * 4;
        ok(offset + size <= bytes.length, 'RTCP length field runs past the packet');
        types.push(bytes[offset + 1]);
        offset += size;
    }
    strictEqual(offset, bytes.length);
    return types;
}

const SSRC = 0x73fd5806;
const SOURCE = 0x12671595;

// ===================================================================
//  Receiver report
// ===================================================================
describe('receiverReport', () => {
    it('reproduces a report with only a sequence number', () => {
        const out = receiverReport({ ssrc: SSRC, sourceSsrc: SOURCE, highestSeq: 0x6361 });
        strictEqual(toHex(out), toHex(hex(
            '81c90007 73fd5806 12671595 00000000 00006361 00000000 00000000 00000000' +
            '81ca0002 73fd5806 01000000')));
    });

    it('reproduces a report with jitter, LSR and DLSR', () => {
        const out = receiverReport({
            ssrc: SSRC, sourceSsrc: SOURCE, highestSeq: 0x6e9c,
            jitter: 0x667, lsr: 0x01bb8eb5, dlsr: 0x0bf1,
        });
        strictEqual(toHex(out), toHex(hex(
            '81c90007 73fd5806 12671595 00000000 00006e9c 00000667 01bb8eb5 00000bf1' +
            '81ca0002 73fd5806 01000000')));
    });

    it('is a 44-byte Uint8Array', () => {
        const out = receiverReport({ ssrc: 1, sourceSsrc: 2, highestSeq: 3 });
        ok(out instanceof Uint8Array);
        strictEqual(out.length, 44);
    });

    it('is a receiver report followed by an SDES packet', () => {
        const out = receiverReport({ ssrc: 1, sourceSsrc: 2, highestSeq: 3 });
        deepStrictEqual(packetTypes(out), [201, 202]);
        strictEqual(u16(out, 2), 7);
        strictEqual(u16(out, 34), 2);
    });

    it('defaults the optional fields to 0', () => {
        const out = receiverReport({ ssrc: 1, sourceSsrc: 2, highestSeq: 3 });
        deepStrictEqual(out.subarray(12, 16), hex('00000000'));
        deepStrictEqual(out.subarray(20, 32), hex('000000000000000000000000'));
        deepStrictEqual(out, receiverReport({
            ssrc: 1, sourceSsrc: 2, highestSeq: 3,
            jitter: 0, lsr: 0, dlsr: 0, fractionLost: 0, cumulativeLost: 0,
        }));
    });

    it('writes the loss fields', () => {
        const out = receiverReport({
            ssrc: 1, sourceSsrc: 2, highestSeq: 3, fractionLost: 0x40, cumulativeLost: 0x010203,
        });
        deepStrictEqual(out.subarray(12, 16), hex('40010203'));
    });

    it('accepts SSRCs with the top bit set', () => {
        const out = receiverReport({ ssrc: 0xfedcba98, sourceSsrc: 0x80000000, highestSeq: 0xffffffff });
        strictEqual(u32(out, 4), 0xfedcba98);
        strictEqual(u32(out, 8), 0x80000000);
        strictEqual(u32(out, 16), 0xffffffff);
        strictEqual(u32(out, 36), 0xfedcba98);
    });

    it('clamps values to their fields', () => {
        const out = receiverReport({
            ssrc: 2 ** 32 + 5, sourceSsrc: 2 ** 40, highestSeq: 2 ** 33,
            jitter: 2 ** 32, lsr: Infinity, dlsr: 2 ** 53,
            fractionLost: 256, cumulativeLost: 2 ** 24,
        });
        strictEqual(toHex(out), toHex(hex(
            '81c90007 ffffffff ffffffff ffffffff ffffffff ffffffff 00000000 ffffffff' +
            '81ca0002 ffffffff 01000000')));
    });

    it('turns negative and non-finite values into 0', () => {
        const out = receiverReport({
            ssrc: SSRC, sourceSsrc: SOURCE, highestSeq: -1,
            jitter: NaN, lsr: -Infinity, dlsr: -0.5,
            fractionLost: -3, cumulativeLost: NaN,
        });
        deepStrictEqual(out, receiverReport({ ssrc: SSRC, sourceSsrc: SOURCE, highestSeq: 0 }));
    });

    it('floors fractional values', () => {
        const out = receiverReport({
            ssrc: 1.9, sourceSsrc: 2.5, highestSeq: 3.99,
            jitter: 4.7, lsr: 5.1, dlsr: 6.999,
            fractionLost: 7.5, cumulativeLost: 8.5,
        });
        deepStrictEqual(out, receiverReport({
            ssrc: 1, sourceSsrc: 2, highestSeq: 3,
            jitter: 4, lsr: 5, dlsr: 6, fractionLost: 7, cumulativeLost: 8,
        }));
    });
});

// ===================================================================
//  Picture acknowledgement
// ===================================================================
describe('pictureAck', () => {
    it('reproduces an acknowledgement', () => {
        const out = pictureAck({ ssrc: SSRC, don: 0x3196 });
        strictEqual(toHex(out), toHex(hex('80cc0003 73fd5806 00000005 00003196')));
    });

    it('is a single 16-byte APP packet', () => {
        const out = pictureAck({ ssrc: 1, don: 2 });
        ok(out instanceof Uint8Array);
        strictEqual(out.length, 16);
        deepStrictEqual(packetTypes(out), [204]);
        strictEqual(u16(out, 2), 3);
    });

    it('accepts an SSRC with the top bit set', () => {
        const out = pictureAck({ ssrc: 0x80000001, don: 0xffff });
        strictEqual(toHex(out), toHex(hex('80cc0003 80000001 00000005 0000ffff')));
    });

    it('writes the decoding order number as a u32', () => {
        strictEqual(u32(pictureAck({ ssrc: 1, don: 0x12345678 }), 12), 0x12345678);
        strictEqual(u32(pictureAck({ ssrc: 1, don: 2 ** 32 }), 12), 0xffffffff);
    });

    it('clamps and floors', () => {
        strictEqual(u32(pictureAck({ ssrc: 1, don: -1 }), 12), 0);
        strictEqual(u32(pictureAck({ ssrc: 1, don: NaN }), 12), 0);
        strictEqual(u32(pictureAck({ ssrc: 1, don: 7.9 }), 12), 7);
        strictEqual(u32(pictureAck({ ssrc: -1, don: 0 }), 4), 0);
        strictEqual(u32(pictureAck({ ssrc: 2 ** 32, don: 0 }), 4), 0xffffffff);
    });
});

// ===================================================================
//  Rate control report
// ===================================================================
describe('rateControl', () => {
    it('reproduces a report', () => {
        const out = rateControl({ ssrc: SSRC, a: 0x0011, b: 1, c: 0x00000082, d: 0xea60 });
        strictEqual(toHex(out), toHex(hex(
            '80cc0007 73fd5806 5243544c 85000004 0011 00000000 0001 ffff 00000082 ea60')));
    });

    it('is a single 32-byte APP packet named RCTL', () => {
        const out = rateControl({ ssrc: 1, a: 2, b: 3, c: 4, d: 5 });
        ok(out instanceof Uint8Array);
        strictEqual(out.length, 32);
        deepStrictEqual(packetTypes(out), [204]);
        strictEqual(u16(out, 2), 7);
        strictEqual(String.fromCharCode(...out.subarray(8, 12)), 'RCTL');
    });

    it('accepts an SSRC with the top bit set', () => {
        const out = rateControl({ ssrc: 0xdeadbeef, a: 0, b: 0, c: 0xc0000000, d: 0 });
        strictEqual(u32(out, 4), 0xdeadbeef);
        strictEqual(u32(out, 26), 0xc0000000);
    });

    it('clamps values to their fields', () => {
        const out = rateControl({ ssrc: 2 ** 32, a: 65536, b: 70000, c: 2 ** 32, d: 1e9 });
        strictEqual(toHex(out), toHex(hex(
            '80cc0007 ffffffff 5243544c 85000004 ffff 00000000 ffff ffff ffffffff ffff')));
    });

    it('turns negative and non-finite values into 0', () => {
        const out = rateControl({ ssrc: SSRC, a: -1, b: NaN, c: -Infinity, d: Infinity });
        strictEqual(toHex(out), toHex(hex(
            '80cc0007 73fd5806 5243544c 85000004 0000 00000000 0000 ffff 00000000 0000')));
    });

    it('treats missing values as 0', () => {
        const out = rateControl({ ssrc: SSRC });
        deepStrictEqual(out, rateControl({ ssrc: SSRC, a: 0, b: 0, c: 0, d: 0 }));
    });

    it('floors fractional values', () => {
        const out = rateControl({ ssrc: 1.5, a: 17.9, b: 49.99, c: 130.2, d: 59999.5 });
        deepStrictEqual(out, rateControl({ ssrc: 1, a: 17, b: 49, c: 130, d: 59999 }));
    });
});
