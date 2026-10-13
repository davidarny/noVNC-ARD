/*
 * noVNC-ARD: MVS (encoding 1011) decoder tests.
 *
 * Hand-built bitstreams for a 16x8 screen (two tiles). They pin down the
 * state the decoder has to keep between updates, which is what the
 * bitstream cannot tell you on its own.
 *
 * Run: node --test ard/tests/test.mvs.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, notDeepStrictEqual } from 'node:assert';

// noVNC's logging module expects a browser. Capture its warnings instead:
// the decoder warns when an update does not end on its marker.
const warnings = [];
globalThis.window = globalThis;
console.warn = (...args) => warnings.push(args.join(' '));
const { default: ArdMVSDecoder } = await import('../decoders/mvs.js');

const { idct8x8, idctFlat } = await import('../decoders/mvs-idct.js');

const WIDTH = 16;
const HEIGHT = 8;

// Join bit strings (spaces ignored) into bytes, zero padded
function bits(...parts) {
    const all = parts.join('').replace(/\s/g, '');
    const out = new Uint8Array(Math.ceil(all.length / 8));
    for (let i = 0; i < all.length; i++) {
        if (all[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
}

function marker(text) {
    return [...text].map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');
}

function fullUpdate(threshold1, threshold2, header, body) {
    const bodyOffset = 6 + header.length;
    return Uint8Array.from([0x00, threshold1, threshold2,
                            bodyOffset >> 16, (bodyOffset >> 8) & 0xff, bodyOffset & 0xff,
                            ...header, ...body]);
}

function partialUpdate(crLimit, cbLimit, body) {
    return Uint8Array.from([0x01, crLimit, cbLimit, ...body]);
}

class Screen {
    constructor(width = WIDTH, height = HEIGHT) {
        this.width = width;
        this.height = height;
        this.pixels = new Uint8Array(width * height * 4);
    }

    blitImage(x, y, width, height, arr, offset) {
        for (let row = 0; row < height; row++) {
            const src = offset + row * width * 4;
            this.pixels.set(arr.subarray(src, src + width * 4),
                            ((y + row) * this.width + x) * 4);
        }
    }

    // RGB of one pixel
    pixel(x, y) {
        const start = (y * this.width + x) * 4;
        return Array.from(this.pixels.subarray(start, start + 3));
    }

    // RGB of the top-left pixel of a tile
    tile(index) {
        return Array.from(this.pixels.subarray(index * 32, index * 32 + 3));
    }

    // All 8x8 RGBA pixels of a tile
    tilePixels(index) {
        const out = [];
        for (let row = 0; row < 8; row++) {
            const start = (row * WIDTH + index * 8) * 4;
            out.push(...this.pixels.subarray(start, start + 32));
        }
        return out;
    }
}

function decode(decoder, screen, payload, x = 0, y = 0) {
    const sock = {
        rQwait: () => false,
        rQshift32: () => payload.length,
        rQshiftBytes: () => payload,
    };
    decoder.decodeRect(x, y, WIDTH, HEIGHT, sock, screen, 24);
}

// Full update: tile 0 is a DCT tile with Y DC = 10 and neutral chroma,
// tile 1 repeats it.
const FULL = fullUpdate(15, 25,
    bits('0',               // ignored leading bit
         '101 1 0000',      // type 5, run of 2
         marker('m')),
    bits('0 0 0',           // new tile, chroma DC coded, threshold1
         '00', '00',        // Cb DC +0, Cr DC +0
         '1110 010 1',      // Y DC: predictor 0 minus (-10)
         '0 01 0',          // end of block
         '1',               // tile 1: repeat
         marker('m')));

// Same, but tile 0 also has Y AC position 1 = +2
const FULL_AC = fullUpdate(15, 25,
    bits('0', '101 1 0000', marker('m')),
    bits('0 0 0', '00', '00', '1110 010 1',
         '0 10',            // position 1: plus one quantization step
         '0 01 0',
         '1',
         marker('m')));

const EOB = '1010';         // K.5 code for symbol 0x00

// Partial updates re-coding tile 0 with Y AC position 1 one step up, or
// unchanged; tile 1 skipped
function partialAC(step) {
    return partialUpdate(14, 19,
        bits('01', '000001', // DCT tile, Y AC position 1 coded
             step,
             '0', EOB,
             '0', EOB,
             '00',
             marker('mvs')));
}

// Partial update: tile 0 re-coded with Cr DC one step up, tile 1 skipped
const PARTIAL_CR_UP = partialUpdate(14, 19,
    bits('01', '000000',    // DCT tile, no Y AC positions
         '1 0', EOB,        // Cr DC: baseline 0, step, positive
         '0', EOB,          // Cb DC unchanged
         '00',
         marker('mvs')));

// Partial update: tile 0 re-coded with no changes, tile 1 skipped
const PARTIAL_UNCHANGED = partialUpdate(14, 19,
    bits('01', '000000',
         '0', EOB,
         '0', EOB,
         '00',
         marker('mvs')));

// Partial update: tile 0 skipped, tile 1 from cache slot 1
const PARTIAL_CACHE_1 = partialUpdate(14, 19,
    bits('00',
         '11 0 0000000000000001',
         marker('mvs')));

// Partial update: tile 0 skipped, tile 1 from the slot after the last loaded
const PARTIAL_CACHE_NEXT = partialUpdate(14, 19,
    bits('00',
         '11 1',
         marker('mvs')));

const GRAY = [148, 148, 148];
const REDDISH = [151, 147, 148];

function run(...payloads) {
    const decoder = new ArdMVSDecoder();
    const screen = new Screen();
    warnings.length = 0;
    for (const payload of payloads) {
        decode(decoder, screen, payload);
    }
    return screen;
}

describe('MVS full update', () => {
    it('decodes a DCT tile and a repeat of it', () => {
        const screen = run(FULL);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tile(0), GRAY);
        deepStrictEqual(screen.tile(1), GRAY);
    });

    it('dequantizes with tables from a quantization update', () => {
        const tables = new Uint8Array(129).fill(8);
        tables[0] = 0x02;
        const decoder = new ArdMVSDecoder();
        const screen = new Screen();
        warnings.length = 0;
        const sock = {
            rQwait: () => false,
            rQshift32: () => tables.length,
            rQshiftBytes: () => tables,
        };
        decoder.decodeRect(0, 0, 0, 0, sock, screen, 24);
        decode(decoder, screen, FULL);
        deepStrictEqual(warnings, []);
        // Y DC 10 × 8 / 8 = 10 above mid-gray
        deepStrictEqual(screen.tile(0), [138, 138, 138]);
    });
});

describe('MVS partial update', () => {
    it('applies a chroma DC step to a DCT tile', () => {
        const screen = run(FULL, PARTIAL_CR_UP);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tile(0), REDDISH);
        deepStrictEqual(screen.tile(1), GRAY);
    });

    it('codes every partial against the last full update', () => {
        // The second partial says "unchanged". That is relative to the
        // full update, not to the partial before it.
        const screen = run(FULL, PARTIAL_CR_UP, PARTIAL_UNCHANGED);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tile(0), GRAY);
    });

    it('takes the Y AC baseline from the full update too', () => {
        const full = run(FULL_AC).tilePixels(0);
        const stepped = run(FULL_AC, partialAC('1')).tilePixels(0);
        deepStrictEqual(warnings, []);
        notDeepStrictEqual(stepped, full);

        const screen = run(FULL_AC, partialAC('1'), partialAC('0'));
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tilePixels(0), full);
    });

    it('caches partial DCT tiles only, starting at slot 1', () => {
        const screen = run(FULL, PARTIAL_CR_UP, PARTIAL_UNCHANGED, PARTIAL_CACHE_1);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tile(1), REDDISH);
    });

    it('takes "next" as the slot after the last one loaded', () => {
        const screen = run(FULL, PARTIAL_CR_UP, PARTIAL_UNCHANGED,
                           PARTIAL_CACHE_1, PARTIAL_CACHE_NEXT);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.tile(1), GRAY);
    });

    it('rejects a cache slot that was never written', () => {
        const screen = run(FULL, PARTIAL_CACHE_1);
        deepStrictEqual(warnings.length, 1);
        deepStrictEqual(screen.tile(1), GRAY);
    });
});

// With several displays combined into one framebuffer, each display is
// sent as its own rectangle, and a display need not start on a multiple
// of 8 pixels.
describe('MVS rectangle inside a larger framebuffer', () => {
    // A 16x8 display placed at 16,3 in a 32x16 framebuffer
    const X = 16;
    const Y = 3;

    function runAt(...payloads) {
        const decoder = new ArdMVSDecoder();
        const screen = new Screen(32, 16);
        warnings.length = 0;
        for (const payload of payloads) {
            decode(decoder, screen, payload, X, Y);
        }
        return screen;
    }

    it('decodes a rectangle that does not start on a tile boundary', () => {
        const screen = runAt(FULL);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.pixel(X, Y), GRAY);
        deepStrictEqual(screen.pixel(X + 15, Y + 7), GRAY);
        // Nothing outside the rectangle is touched
        deepStrictEqual(screen.pixel(X, Y - 1), [0, 0, 0]);
        deepStrictEqual(screen.pixel(X, Y + 8), [0, 0, 0]);
        deepStrictEqual(screen.pixel(X - 1, Y), [0, 0, 0]);
    });

    it('keeps the baseline and the cache for such a rectangle', () => {
        const screen = runAt(FULL, PARTIAL_CR_UP, PARTIAL_UNCHANGED, PARTIAL_CACHE_1);
        deepStrictEqual(warnings, []);
        deepStrictEqual(screen.pixel(X, Y), GRAY);
        deepStrictEqual(screen.pixel(X + 8, Y), REDDISH);
    });

    it('rejects a rectangle that leaves the framebuffer', () => {
        const decoder = new ArdMVSDecoder();
        const screen = new Screen(32, 16);
        warnings.length = 0;
        decode(decoder, screen, FULL, 24, 3);
        deepStrictEqual(warnings.length, 1);
        deepStrictEqual(screen.pixel(24, 3), [0, 0, 0]);
    });
});

describe('MVS inverse DCT', () => {
    it('gives a DC-only block the value the full transform gives it', () => {
        const block = new Int32Array(64);
        const samples = new Uint8Array(64);
        // Covers every DC a tile can have: int8 coefficient × 8-bit step,
        // and beyond, into the range where samples wrap
        for (let dc = -40000; dc <= 40000; dc++) {
            block[0] = dc;
            idct8x8(block, samples);
            const flat = idctFlat(dc);
            if (samples[0] !== flat || samples[63] !== flat) {
                deepStrictEqual({ dc, flat }, { dc, flat: samples[0] });
            }
        }
    });
});
