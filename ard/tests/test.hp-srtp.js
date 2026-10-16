/*
 * Unit tests for SRTP/SRTCP AES_256_CM_HMAC_SHA1_80 (ard/hp/srtp.js)
 *
 * All keys and packets are synthetic. The "reference" hex was produced by the
 * Python reference decoder's key derivation and a protect routine verified
 * against that decoder.
 *
 * Run: node --test ard/tests/test.hp-srtp.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, rejects } from 'node:assert';

import { createContext, deriveSessionKeys } from '../hp/srtp.js';

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g) || [];
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// Helper: Uint8Array → hex string (for readable assertion messages)
function toHex(arr) {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: deterministic filler bytes
function fill(n, seed = 1) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 17) & 0xff;
    return out;
}

// Helper: build a plain RTP packet
function rtp({ seq, ssrc, timestamp = 0, marker = false, payloadType = 100,
               csrc = [], extension = new Uint8Array(0), payload = new Uint8Array(0) }) {
    const headerLen = 12 + 4 * csrc.length;
    const out = new Uint8Array(headerLen + extension.length + payload.length);
    const dv = new DataView(out.buffer);
    out[0] = 0x80 | (extension.length ? 0x10 : 0) | csrc.length;
    out[1] = (marker ? 0x80 : 0) | payloadType;
    dv.setUint16(2, seq);
    dv.setUint32(4, timestamp);
    dv.setUint32(8, ssrc);
    csrc.forEach((c, i) => dv.setUint32(12 + 4 * i, c));
    out.set(extension, headerLen);
    out.set(payload, headerLen + extension.length);
    return out;
}

// Helper: build a plain RTCP packet, 8-byte header plus body
function rtcp(ssrc, body = new Uint8Array(0)) {
    const out = new Uint8Array(8 + body.length);
    const dv = new DataView(out.buffer);
    out[0] = 0x80;
    out[1] = 204;
    dv.setUint16(2, (out.length >> 2) - 1);
    dv.setUint32(4, ssrc);
    out.set(body, 8);
    return out;
}

const MK = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const MS = hex('a0a1a2a3a4a5a6a7a8a9aaabacad');
const OTHER_MK = hex('ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const EXT = hex('9311000100030007');
const SIZES = [0, 1, 15, 16, 17, 1400];

// ===================================================================
//  Key derivation
// ===================================================================
describe('SRTP key derivation', () => {
    it('matches RFC 6188 section 7.1 (AES-256)', async () => {
        const keys = await deriveSessionKeys(
            hex('f0f04914b513f2763a1b1fa130f10e2998f6f6e43e4309d1e622a0e332b9f1b6'),
            hex('3b04803de51ee7c96423ab5b78d2'));
        strictEqual(toHex(keys.rtp.cipherKey),
                    '5ba1064e30ec51613cad926c5a28ef731ec7fb397f70a960653caf06554cd8c4');
        strictEqual(toHex(keys.rtp.authKey), 'fd9c32d39ed5fbb5a9dc96b30818454d1313dc05');
        strictEqual(toHex(keys.rtp.salt), 'fa31791685ca444a9e07c6c64e93');
    });

    it('matches the reference for all six labels', async () => {
        const keys = await deriveSessionKeys(MK, MS);
        strictEqual(toHex(keys.rtp.cipherKey),
                    '8ff338062f0014ad7018ceda7ad30d784b582faa338d95c29f02aab161a7f31f');
        strictEqual(toHex(keys.rtp.authKey), 'b916d2a76f03cb2e48ab6252a31f228a41f248b7');
        strictEqual(toHex(keys.rtp.salt), 'd77cbb7a53e2e86a097453231e04');
        strictEqual(toHex(keys.rtcp.cipherKey),
                    '618488fb3a5f72a110bd921dd2c5f34ceca03ce395457d6d4451d122d4dc3b61');
        strictEqual(toHex(keys.rtcp.authKey), 'a7111d61dc1271672d1c73d5f13c14d85a999e86');
        strictEqual(toHex(keys.rtcp.salt), '2999a34fecf08950cee6db7e19e1');
    });

    it('rejects a master key or salt of the wrong size', async () => {
        await rejects(createContext(MK.subarray(0, 16), MS), TypeError);
        await rejects(createContext(MK, MS.subarray(0, 12)), TypeError);
        await rejects(createContext('not bytes', MS), TypeError);
    });
});

// ===================================================================
//  Reference vectors
// ===================================================================
describe('SRTP reference vectors', () => {
    // [name, plain RTP, SRTP]; C1 and C2 are one SSRC either side of a rollover
    const RTP = [
        ['no extension',
         '806412340001020311223344303132333435363738393a3b3c3d3e3f40414243',
         '8064123400010203112233445f4032dd3cb990dc23907f5dded8392babd46d829e116069d41f8cb8b3dd'],
        ['extension and marker',
         '90e40042fedcba98deadbeef9311000100030007030a11181f262d343b424950575e656c737a81888f96' +
         '9da4abb2b9c0c7ced5dce3eaf1f8ff',
         '90e40042fedcba98deadbeef9311000100030007c9317c018f616e695c38b99fbbfbd1b62bd9b94dc5aa' +
         '67c482b280c1c47b535108c1dda93a23f3cc39fedcd6c90ebf'],
        ['seq 65535, rollover counter 0',
         '9064ffff00002ee00badcafe931100010003000700010409101924314051647990a9c4e1',
         '9064ffff00002ee00badcafe93110001000300071011a946ebf7daf15f1324ff341d3a7ecfba81497160' +
         'eb818984'],
        ['seq 0, rollover counter 1',
         '90e4000000002ee00badcafe9311000100030007fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0' +
         'bdbab7b4b1aeaba8a5a29f',
         '90e4000000002ee00badcafe931100010003000795097496397d2a5b95d9ab49f46a3a34a45694d4c77f' +
         '73b7574473a907903cc43d04cfc3dcf2b4015d3001'],
    ];
    // [name, plain RTCP, SRTCP]; indices 1 and 2
    const RTCP = [
        ['receiver report and source description, index 1',
         '81c900070a0b0c0d11223344000000000000123400000000000000000000000081ca00020a0b0c0d0100' +
         '0000',
         '81c900070a0b0c0d750c6119dd9174e387108b4c8fdc8f6f24030af2b97a69b63dff6c1338531c49e31d' +
         'ff81800000010b45224572b32ecb2b88'],
        ['empty receiver report, index 2',
         '80c900010a0b0c0d',
         '80c900010a0b0c0d800000028292dc86ed371a70208e'],
    ];

    it('unprotects reference SRTP packets', async () => {
        const ctx = await createContext(MK, MS);
        for (const [name, plainHex, srtpHex] of RTP) {
            const plain = hex(plainHex);
            const r = await ctx.unprotectRtp(hex(srtpHex));
            ok(r, name);
            const hasExt = (plain[0] & 0x10) !== 0;
            const dv = new DataView(plain.buffer);
            strictEqual(r.ssrc, dv.getUint32(8), name);
            strictEqual(r.seq, dv.getUint16(2), name);
            strictEqual(r.timestamp, dv.getUint32(4), name);
            strictEqual(r.marker, (plain[1] & 0x80) !== 0, name);
            strictEqual(r.payloadType, 100, name);
            strictEqual(toHex(r.header), toHex(plain.subarray(0, 12)), name);
            strictEqual(toHex(r.extension), hasExt ? toHex(EXT) : '', name);
            strictEqual(toHex(r.payload), toHex(plain.subarray(hasExt ? 20 : 12)), name);
        }
    });

    it('protects RTP to the reference bytes', async () => {
        const ctx = await createContext(MK, MS);
        for (const [name, plainHex, srtpHex] of RTP) {
            strictEqual(toHex(await ctx.protectRtp(hex(plainHex))), srtpHex, name);
        }
    });

    it('unprotects reference SRTCP packets', async () => {
        const ctx = await createContext(MK, MS);
        for (const [name, plainHex, srtcpHex] of RTCP) {
            const r = await ctx.unprotectRtcp(hex(srtcpHex));
            ok(r, name);
            strictEqual(toHex(r), plainHex, name);
        }
    });

    it('protects RTCP to the reference bytes', async () => {
        const ctx = await createContext(MK, MS);
        for (const [name, plainHex, srtcpHex] of RTCP) {
            strictEqual(toHex(await ctx.protectRtcp(hex(plainHex))), srtcpHex, name);
        }
    });
});

// ===================================================================
//  Round trips
// ===================================================================
describe('SRTP round trips', () => {
    it('round-trips RTP without a header extension', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        for (const [i, size] of SIZES.entries()) {
            const payload = fill(size, i);
            const plain = rtp({ seq: 100 + i, ssrc: 0x01020304, timestamp: 400 * i, payload });
            const wire = await tx.protectRtp(plain);
            strictEqual(wire.length, plain.length + 10);
            const r = await rx.unprotectRtp(wire);
            ok(r, `size ${size}`);
            deepStrictEqual(r.payload, payload);
            deepStrictEqual(r.header, plain.subarray(0, 12));
            strictEqual(r.extension.length, 0);
            strictEqual(r.seq, 100 + i);
            strictEqual(r.timestamp, 400 * i);
            strictEqual(r.marker, false);
        }
    });

    it('round-trips RTP with a header extension', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        for (const [i, size] of SIZES.entries()) {
            const payload = fill(size, i + 7);
            const plain = rtp({ seq: i, ssrc: 0xfffffff0, timestamp: 0xfffffff0, marker: true,
                                extension: EXT, payload });
            const wire = await tx.protectRtp(plain);
            // Header and extension stay in the clear.
            deepStrictEqual(wire.subarray(0, 20), plain.subarray(0, 20));
            const r = await rx.unprotectRtp(wire);
            ok(r, `size ${size}`);
            deepStrictEqual(r.payload, payload);
            deepStrictEqual(r.extension, EXT);
            strictEqual(r.ssrc, 0xfffffff0);
            strictEqual(r.timestamp, 0xfffffff0);
            strictEqual(r.marker, true);
            strictEqual(r.payloadType, 100);
        }
    });

    it('returns contributing sources as part of the header', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const payload = fill(40);
        const plain = rtp({ seq: 9, ssrc: 5, csrc: [0xaabbccdd, 0x11223344], extension: EXT, payload });
        const r = await rx.unprotectRtp(await tx.protectRtp(plain));
        ok(r);
        deepStrictEqual(r.header, plain.subarray(0, 20));
        deepStrictEqual(r.extension, EXT);
        deepStrictEqual(r.payload, payload);
    });

    it('encrypts the payload', async () => {
        const tx = await createContext(MK, MS);
        const payload = fill(64);
        const wire = await tx.protectRtp(rtp({ seq: 1, ssrc: 2, payload }));
        ok(toHex(wire.subarray(12, 76)) !== toHex(payload));
    });

    it('accepts a packet that is a view into a larger buffer', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const payload = fill(50);
        const wire = await tx.protectRtp(rtp({ seq: 3, ssrc: 4, payload }));
        const big = new Uint8Array(wire.length + 9);
        big.set(wire, 5);
        const r = await rx.unprotectRtp(big.subarray(5, 5 + wire.length));
        ok(r);
        deepStrictEqual(r.payload, payload);
    });

    it('round-trips RTCP', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        for (const [i, size] of SIZES.entries()) {
            const plain = rtcp(0x80000001, fill(size, i));
            const wire = await tx.protectRtcp(plain);
            strictEqual(wire.length, plain.length + 14);
            deepStrictEqual(wire.subarray(0, 8), plain.subarray(0, 8));
            const r = await rx.unprotectRtcp(wire);
            ok(r, `size ${size}`);
            deepStrictEqual(r, plain);
        }
    });
});

// ===================================================================
//  Rejection
// ===================================================================
describe('SRTP rejection', () => {
    it('rejects an RTP packet with any one bit flipped', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const wire = await tx.protectRtp(rtp({ seq: 7, ssrc: 0x55667788, extension: EXT,
                                               payload: fill(21) }));
        for (let bit = 0; bit < wire.length * 8; bit++) {
            const bad = wire.slice();
            bad[bit >> 3] ^= 0x80 >> (bit & 7);
            strictEqual(await rx.unprotectRtp(bad), null, `bit ${bit}`);
        }
        ok(await rx.unprotectRtp(wire));
    });

    it('rejects an RTCP packet with any one bit flipped', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const wire = await tx.protectRtcp(rtcp(0x55667788, fill(20)));
        for (let bit = 0; bit < wire.length * 8; bit++) {
            const bad = wire.slice();
            bad[bit >> 3] ^= 0x80 >> (bit & 7);
            strictEqual(await rx.unprotectRtcp(bad), null, `bit ${bit}`);
        }
        ok(await rx.unprotectRtcp(wire));
    });

    it('rejects packets shorter than header plus tag', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const wire = await tx.protectRtp(rtp({ seq: 1, ssrc: 1 }));
        strictEqual(wire.length, 22);
        for (let n = 0; n < wire.length; n++) {
            strictEqual(await rx.unprotectRtp(wire.subarray(0, n)), null, `length ${n}`);
        }
        const rtcpWire = await tx.protectRtcp(rtcp(1));
        strictEqual(rtcpWire.length, 22);
        for (let n = 0; n < rtcpWire.length; n++) {
            strictEqual(await rx.unprotectRtcp(rtcpWire.subarray(0, n)), null, `length ${n}`);
        }
    });

    it('rejects a header that claims more than the packet holds', async () => {
        const rx = await createContext(MK, MS);
        const base = new Uint8Array(12 + 10);
        base[0] = 0x90;                      // extension flag, no room for its header
        strictEqual(await rx.unprotectRtp(base), null);
        const longExt = new Uint8Array(12 + 4 + 10);
        longExt[0] = 0x90;
        longExt[15] = 2;                     // two extension words, none present
        strictEqual(await rx.unprotectRtp(longExt), null);
        const csrc = new Uint8Array(12 + 10);
        csrc[0] = 0x8f;                      // fifteen contributing sources, none present
        strictEqual(await rx.unprotectRtp(csrc), null);
    });

    it('rejects input that is not a byte array', async () => {
        const rx = await createContext(MK, MS);
        strictEqual(await rx.unprotectRtp(null), null);
        strictEqual(await rx.unprotectRtp('0'.repeat(40)), null);
        strictEqual(await rx.unprotectRtcp(undefined), null);
        strictEqual(await rx.unprotectRtcp(new ArrayBuffer(40)), null);
    });

    it('rejects packets protected with a different key', async () => {
        const tx = await createContext(OTHER_MK, MS);
        const rx = await createContext(MK, MS);
        strictEqual(await rx.unprotectRtp(await tx.protectRtp(rtp({ seq: 1, ssrc: 1, payload: fill(30) }))), null);
        strictEqual(await rx.unprotectRtcp(await tx.protectRtcp(rtcp(1, fill(20)))), null);
    });

    it('rejects packets protected with a different salt', async () => {
        const salt = MS.slice();
        salt[0] ^= 1;
        const tx = await createContext(MK, salt);
        const rx = await createContext(MK, MS);
        strictEqual(await rx.unprotectRtp(await tx.protectRtp(rtp({ seq: 1, ssrc: 1, payload: fill(30) }))), null);
        strictEqual(await rx.unprotectRtcp(await tx.protectRtcp(rtcp(1, fill(20)))), null);
    });

    it('does not accept RTP as RTCP or RTCP as RTP', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        strictEqual(await rx.unprotectRtcp(await tx.protectRtp(rtp({ seq: 1, ssrc: 1, payload: fill(30) }))), null);
        strictEqual(await rx.unprotectRtp(await tx.protectRtcp(rtcp(1, fill(30)))), null);
    });
});

// ===================================================================
//  Rollover counter
// ===================================================================
describe('SRTP rollover counter', () => {
    const SSRC = 0x0badcafe;

    // Protect one packet per sequence number, in order, on a fresh sender.
    async function protectRun(seqs, ssrc = SSRC) {
        const tx = await createContext(MK, MS);
        const out = [];
        for (const [i, seq] of seqs.entries()) {
            out.push(await tx.protectRtp(rtp({ seq, ssrc, payload: fill(24, i) })));
        }
        return out;
    }

    it('follows the sequence number across 65535 to 0', async () => {
        const rx = await createContext(MK, MS);
        const seqs = [65534, 65535, 0, 1];
        const wire = await protectRun(seqs);
        for (const [i, seq] of seqs.entries()) {
            const r = await rx.unprotectRtp(wire[i]);
            ok(r, `seq ${seq}`);
            strictEqual(r.seq, seq);
            deepStrictEqual(r.payload, fill(24, i));
        }
    });

    it('uses a different keystream and tag after the rollover', async () => {
        const tx = await createContext(MK, MS);
        const same = rtp({ seq: 0, ssrc: SSRC, payload: fill(24) });
        const before = await tx.protectRtp(same);
        await tx.protectRtp(rtp({ seq: 65535, ssrc: SSRC }));
        const after = await tx.protectRtp(same);
        ok(toHex(before.subarray(12, 36)) !== toHex(after.subarray(12, 36)));
        ok(toHex(before.subarray(36)) !== toHex(after.subarray(36)));
        // A receiver that has not seen the rollover cannot verify the later packet.
        const rx = await createContext(MK, MS);
        strictEqual(await rx.unprotectRtp(after), null);
        ok(await rx.unprotectRtp(before));
    });

    it('verifies a late packet from before the rollover', async () => {
        const rx = await createContext(MK, MS);
        const [a, late, c, d] = await protectRun([65534, 65535, 0, 1]);
        ok(await rx.unprotectRtp(a));
        ok(await rx.unprotectRtp(c));
        ok(await rx.unprotectRtp(d));
        const r = await rx.unprotectRtp(late);
        ok(r);
        strictEqual(r.seq, 65535);
        deepStrictEqual(r.payload, fill(24, 1));
        // The late packet must not pull the counter back.
        ok(await rx.unprotectRtp(d));
        ok(await rx.unprotectRtp(late));
    });

    it('survives a second rollover', async () => {
        const rx = await createContext(MK, MS);
        const seqs = [65535, 0, 30000, 60000, 65535, 0, 1];
        const wire = await protectRun(seqs);
        for (const [i, seq] of seqs.entries()) {
            ok(await rx.unprotectRtp(wire[i]), `step ${i} seq ${seq}`);
        }
    });

    it('keeps a separate counter for each SSRC', async () => {
        const rx = await createContext(MK, MS);
        const first = await protectRun([65535, 0, 1], SSRC);
        const second = await protectRun([0, 1], SSRC + 1);
        for (const p of first) ok(await rx.unprotectRtp(p));
        // SSRC + 1 has not rolled over; its counter is still 0.
        for (const p of second) ok(await rx.unprotectRtp(p));
        ok(await rx.unprotectRtp(first[2]));
    });

    it('does not move the counter for a packet that fails the tag', async () => {
        const rx = await createContext(MK, MS);
        const [a, b] = await protectRun([10, 11]);
        ok(await rx.unprotectRtp(a));
        const forged = rtp({ seq: 40000, ssrc: SSRC, payload: fill(34) });
        strictEqual(await rx.unprotectRtp(forged), null);
        ok(await rx.unprotectRtp(b));
    });
});

// ===================================================================
//  SRTCP index
// ===================================================================
describe('SRTCP index', () => {
    it('starts at 1 with the E bit set and counts up', async () => {
        const tx = await createContext(MK, MS);
        const plain = rtcp(0x0a0b0c0d, fill(20));
        for (let expected = 1; expected <= 3; expected++) {
            const wire = await tx.protectRtcp(plain);
            const word = new DataView(wire.buffer, wire.byteOffset).getUint32(wire.length - 14);
            strictEqual(word >>> 31, 1);
            strictEqual(word & 0x7fffffff, expected);
        }
    });

    it('assigns indices in call order when calls overlap', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const plain = rtcp(0x0a0b0c0d, fill(20));
        const wires = await Promise.all(Array.from({ length: 10 }, () => tx.protectRtcp(plain)));
        for (const [i, wire] of wires.entries()) {
            const word = new DataView(wire.buffer, wire.byteOffset).getUint32(wire.length - 14);
            strictEqual(word, (0x80000000 | (i + 1)) >>> 0);
            deepStrictEqual(await rx.unprotectRtcp(wire), plain);
        }
    });

    it('returns an unencrypted SRTCP packet (E bit clear) unchanged', async () => {
        // Tag computed with the reference RTCP authentication key for MK/MS.
        const authKey = (await deriveSessionKeys(MK, MS)).rtcp.authKey;
        const key = await globalThis.crypto.subtle.importKey(
            'raw', authKey, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
        const plain = rtcp(0x0a0b0c0d, fill(12));
        const signed = new Uint8Array(plain.length + 4);
        signed.set(plain);
        signed[signed.length - 1] = 5;       // E = 0, index 5
        const tag = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, signed));
        const wire = new Uint8Array(signed.length + 10);
        wire.set(signed);
        wire.set(tag.subarray(0, 10), signed.length);
        const rx = await createContext(MK, MS);
        deepStrictEqual(await rx.unprotectRtcp(wire), plain);
    });
});

// ===================================================================
//  Overlapping calls
// ===================================================================
describe('SRTP overlapping calls', () => {
    it('unprotects 50 packets issued together', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const wires = [];
        for (let i = 0; i < 50; i++) {
            wires.push(await tx.protectRtp(rtp({ seq: 1000 + i, ssrc: 0x10 + (i & 3),
                                                 extension: EXT, payload: fill(100 + i, i) })));
        }
        const results = await Promise.all(wires.map(w => rx.unprotectRtp(w)));
        for (const [i, r] of results.entries()) {
            ok(r, `packet ${i}`);
            strictEqual(r.seq, 1000 + i);
            strictEqual(r.ssrc, 0x10 + (i & 3));
            deepStrictEqual(r.payload, fill(100 + i, i));
        }
    });

    it('unprotects 50 packets issued together across a rollover', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const wires = [];
        for (let i = 0; i < 51; i++) {
            wires.push(await tx.protectRtp(rtp({ seq: (65510 + i) & 0xffff, ssrc: 9,
                                                 payload: fill(60, i) })));
        }
        ok(await rx.unprotectRtp(wires[0]));
        // Reverse order: the highest index verifies first, the rest are all "late".
        const results = await Promise.all(wires.slice(1).reverse().map(w => rx.unprotectRtp(w)));
        results.reverse();
        for (const [i, r] of results.entries()) {
            ok(r, `packet ${i + 1}`);
            strictEqual(r.seq, (65511 + i) & 0xffff);
            deepStrictEqual(r.payload, fill(60, i + 1));
        }
        // The counter ended at the highest index, not at the last packet to finish.
        ok(await rx.unprotectRtp(await tx.protectRtp(rtp({ seq: 30, ssrc: 9 }))));
    });

    it('re-estimates when the counter advances while a tag is being checked', async () => {
        const tx = await createContext(MK, MS);
        const rx = await createContext(MK, MS);
        const before = await tx.protectRtp(rtp({ seq: 65535, ssrc: 9, payload: fill(20) }));
        const after = await tx.protectRtp(rtp({ seq: 0, ssrc: 9, payload: fill(20, 2) }));

        // Hold back the first tag computation until the other packet has verified.
        const subtle = globalThis.crypto.subtle;
        const sign = subtle.sign;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let calls = 0;
        subtle.sign = function (...args) {
            const result = sign.apply(this, args);
            return calls++ === 0 ? gate.then(() => result) : result;
        };
        try {
            const pending = rx.unprotectRtp(after);     // no state yet: guesses counter 0
            ok(await rx.unprotectRtp(before));
            release();
            const r = await pending;
            ok(r);
            deepStrictEqual(r.payload, fill(20, 2));
        } finally {
            delete subtle.sign;
        }
        strictEqual(subtle.sign, sign);
    });
});
