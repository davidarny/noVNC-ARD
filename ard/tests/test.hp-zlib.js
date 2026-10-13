/*
 * Unit tests for the zlib (RFC 1950) helpers
 *
 * Run: node --test ard/tests/test.hp-zlib.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';

import { deflate, inflate } from '../hp/zlib.js';

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g) || [];
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// Helper: ASCII string → Uint8Array
function ascii(s) {
    return Uint8Array.from(s, c => c.charCodeAt(0));
}

// Helper: deterministic pseudo-random bytes (compresses poorly)
function noise(length) {
    const out = new Uint8Array(length);
    let x = 0x12345678;
    for (let i = 0; i < length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

// Helper: Adler-32, the checksum that ends an RFC 1950 stream
function adler32(bytes) {
    let a = 1, b = 0;
    for (const byte of bytes) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

// python3 -c "import zlib; print(zlib.compress(b'synthetic zlib test vector ' * 4, 9).hex())"
const PY_TEXT = hex('78da2baecc2bc9482dc94c56a8cac94c5228492d2e51284b4d2ec92f5228a6b61400ea7a297d');
// zlib.compress(b'')
const PY_EMPTY = hex('789c030000000001');
// zlib.compress(b'abc', 0) — a stored block
const PY_STORED = hex('7801010300fcff616263024d0127');

// ===================================================================
//  Round trips
// ===================================================================
describe('zlib round trip', () => {
    it('round trips an empty input', async () => {
        const packed = await deflate(new Uint8Array(0));
        ok(packed.length > 0);
        deepStrictEqual(await inflate(packed), new Uint8Array(0));
    });

    it('round trips a short input', async () => {
        const input = ascii('hello, zlib');
        deepStrictEqual(await inflate(await deflate(input)), input);
    });

    it('round trips 100 kB of noise', async () => {
        const input = noise(100000);
        const packed = await deflate(input);
        const output = await inflate(packed);
        strictEqual(output.length, input.length);
        deepStrictEqual(output, input);
    });

    it('round trips 100 kB of repetitive data and shrinks it', async () => {
        const input = new Uint8Array(100000);
        for (let i = 0; i < input.length; i++) input[i] = i % 7;
        const packed = await deflate(input);
        ok(packed.length < input.length / 10);
        deepStrictEqual(await inflate(packed), input);
    });

    it('returns plain Uint8Arrays', async () => {
        const packed = await deflate(ascii('abc'));
        strictEqual(Object.getPrototypeOf(packed), Uint8Array.prototype);
        strictEqual(Object.getPrototypeOf(await inflate(packed)), Uint8Array.prototype);
    });

    it('reads only the given view of a larger buffer', async () => {
        const backing = ascii('....payload....');
        const view = backing.subarray(4, 11);
        deepStrictEqual(await inflate(await deflate(view)), ascii('payload'));
    });
});

// ===================================================================
//  Stream format
// ===================================================================
describe('zlib stream format', () => {
    it('deflate writes an RFC 1950 header and Adler-32 trailer', async () => {
        const input = ascii('synthetic zlib test vector '.repeat(4));
        const packed = await deflate(input);
        strictEqual(packed[0] & 0x0f, 8);                       // CM = deflate
        strictEqual(((packed[0] << 8) | packed[1]) % 31, 0);    // FCHECK
        strictEqual(packed[1] & 0x20, 0);                       // no preset dictionary
        const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
        strictEqual(dv.getUint32(packed.length - 4), adler32(input));
    });

    it('inflates a stream written by Python zlib', async () => {
        deepStrictEqual(await inflate(PY_TEXT), ascii('synthetic zlib test vector '.repeat(4)));
    });

    it('inflates an empty stream written by Python zlib', async () => {
        deepStrictEqual(await inflate(PY_EMPTY), new Uint8Array(0));
    });

    it('inflates a stored block', async () => {
        deepStrictEqual(await inflate(PY_STORED), ascii('abc'));
    });
});

// ===================================================================
//  Corrupt input
// ===================================================================
describe('zlib corrupt input', () => {
    it('rejects a bad header', async () => {
        const bad = PY_TEXT.slice();
        bad[0] = 0x00;
        await rejects(inflate(bad));
    });

    it('rejects a raw deflate stream (no zlib wrapper)', async () => {
        await rejects(inflate(PY_TEXT.subarray(2, PY_TEXT.length - 4)));
    });

    it('rejects a gzip stream', async () => {
        await rejects(inflate(hex('1f8b0800000000000003030000000000 00000000')));
    });

    it('rejects a corrupted body', async () => {
        const bad = PY_STORED.slice();
        bad[3] ^= 0xff;     // stored block length no longer matches its complement
        await rejects(inflate(bad));
    });

    it('rejects a wrong checksum', async () => {
        const bad = PY_TEXT.slice();
        bad[bad.length - 1] ^= 0x01;
        await rejects(inflate(bad));
    });

    it('rejects a truncated stream', async () => {
        await rejects(inflate(PY_TEXT.subarray(0, PY_TEXT.length - 5)));
        await rejects(inflate(PY_TEXT.subarray(0, 2)));
    });

    it('rejects an empty input', async () => {
        await rejects(inflate(new Uint8Array(0)));
    });

    it('rejects input that is not a Uint8Array', async () => {
        await rejects(inflate('789c'));
        await rejects(deflate(null));
    });

    it('still works after a rejection', async () => {
        await rejects(inflate(hex('00 01 02 03')));
        deepStrictEqual(await inflate(PY_STORED), ascii('abc'));
    });
});
