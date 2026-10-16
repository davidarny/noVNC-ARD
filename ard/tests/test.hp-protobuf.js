/*
 * Unit tests for the schema-less protocol buffer codec
 *
 * Run: node --test ard/tests/test.hp-protobuf.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import { decode, encode, get, getAll } from '../hp/protobuf.js';

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g) || [];
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// ===================================================================
//  Varints
// ===================================================================
describe('protobuf varints', () => {
    const edges = [
        [0, '08 00'],
        [127, '08 7f'],
        [128, '08 80 01'],
        [300, '08 ac 02'],
        [2 ** 32, '08 80 80 80 80 10'],
        [Number.MAX_SAFE_INTEGER, '08 ff ff ff ff ff ff ff 0f'],
    ];

    for (const [value, bytes] of edges) {
        it(`encodes and decodes ${value} as a Number`, () => {
            const encoded = encode([{ field: 1, wire: 0, value }]);
            deepStrictEqual(encoded, hex(bytes));
            const fields = decode(encoded);
            deepStrictEqual(fields, [{ field: 1, wire: 0, value }]);
            strictEqual(typeof fields[0].value, 'number');
        });
    }

    it('encodes and decodes 2^64-1 as a BigInt', () => {
        const value = 2n ** 64n - 1n;
        const encoded = encode([{ field: 1, wire: 0, value }]);
        deepStrictEqual(encoded, hex('08 ff ff ff ff ff ff ff ff ff 01'));
        deepStrictEqual(decode(encoded), [{ field: 1, wire: 0, value }]);
    });

    it('decodes 2^53 as a BigInt (first value past the safe range)', () => {
        const fields = decode(hex('08 80 80 80 80 80 80 80 10'));
        strictEqual(fields[0].value, 2n ** 53n);
    });

    it('encodes a small BigInt like the same Number', () => {
        deepStrictEqual(encode([{ field: 1, value: 300n }]), hex('08 ac 02'));
        strictEqual(decode(hex('08 ac 02'))[0].value, 300);
    });

    it('rejects a varint longer than ten bytes', () => {
        throws(() => decode(hex('08 80 80 80 80 80 80 80 80 80 80 01')));
    });

    it('rejects a ten-byte varint that overflows 64 bits', () => {
        throws(() => decode(hex('08 ff ff ff ff ff ff ff ff ff 02')));
    });
});

// ===================================================================
//  Messages
// ===================================================================
describe('protobuf messages', () => {
    it('decodes an empty message to an empty list', () => {
        deepStrictEqual(decode(new Uint8Array(0)), []);
        deepStrictEqual(encode([]), new Uint8Array(0));
    });

    it('round trips a nested message', () => {
        const inner = encode([
            { field: 1, wire: 0, value: 42 },
            { field: 2, wire: 2, value: hex('de ad be ef') },
        ]);
        const middle = encode([
            { field: 3, wire: 2, value: inner },
            { field: 4, wire: 0, value: 7 },
        ]);
        const outer = encode([
            { field: 1, wire: 0, value: 1 },
            { field: 15, wire: 2, value: middle },
        ]);

        const top = decode(outer);
        strictEqual(get(top, 1), 1);
        const mid = decode(get(top, 15));
        strictEqual(get(mid, 4), 7);
        deepStrictEqual(decode(get(mid, 3)), [
            { field: 1, wire: 0, value: 42 },
            { field: 2, wire: 2, value: hex('de ad be ef') },
        ]);
    });

    it('keeps repeated and interleaved fields in wire order', () => {
        const fields = [
            { field: 2, wire: 0, value: 10 },
            { field: 1, wire: 2, value: hex('01') },
            { field: 2, wire: 0, value: 20 },
            { field: 1, wire: 2, value: hex('02 03') },
            { field: 2, wire: 0, value: 30 },
        ];
        deepStrictEqual(decode(encode(fields)), fields);
    });

    it('passes fixed64 and fixed32 through as raw bytes', () => {
        const fields = [
            { field: 1, wire: 1, value: hex('01 02 03 04 05 06 07 08') },
            { field: 2, wire: 5, value: hex('0a 0b 0c 0d') },
        ];
        const encoded = encode(fields);
        deepStrictEqual(encoded, hex('09 01 02 03 04 05 06 07 08  15 0a 0b 0c 0d'));
        deepStrictEqual(decode(encoded), fields);
    });

    it('handles multi-byte tags', () => {
        const fields = [
            { field: 16, wire: 0, value: 1 },
            { field: 2 ** 29 - 1, wire: 2, value: hex('ff') },
        ];
        const encoded = encode(fields);
        deepStrictEqual(encoded, hex('80 01 01  fa ff ff ff 0f 01 ff'));
        deepStrictEqual(decode(encoded), fields);
    });

    it('round trips a length-delimited value longer than 127 bytes', () => {
        const value = new Uint8Array(300);
        for (let i = 0; i < value.length; i++) value[i] = (i * 13) & 0xff;
        const encoded = encode([{ field: 1, wire: 2, value }]);
        deepStrictEqual(encoded.subarray(0, 3), hex('0a ac 02'));
        deepStrictEqual(decode(encoded), [{ field: 1, wire: 2, value }]);
    });

    it('returns values that do not alias the input', () => {
        const input = hex('0a 02 01 02');
        const value = decode(input)[0].value;
        input[2] = 0x99;
        deepStrictEqual(value, hex('01 02'));
    });
});

// ===================================================================
//  Malformed input
// ===================================================================
describe('protobuf malformed input', () => {
    it('throws on a truncated varint', () => {
        throws(() => decode(hex('08 80')));
    });

    it('throws on a tag with no value', () => {
        throws(() => decode(hex('08')));
        throws(() => decode(hex('0a')));
    });

    it('throws on a truncated tag', () => {
        throws(() => decode(hex('08 01 80')));
    });

    it('throws on truncated length-delimited data', () => {
        throws(() => decode(hex('0a 05 01 02 03 04')));
    });

    it('throws on truncated fixed64 and fixed32', () => {
        throws(() => decode(hex('09 01 02 03 04 05 06 07')));
        throws(() => decode(hex('15 01 02 03')));
    });

    it('throws on every proper prefix of a valid message', () => {
        const whole = encode([
            { field: 1, wire: 0, value: 300 },
            { field: 2, wire: 2, value: hex('aa bb cc') },
            { field: 3, wire: 5, value: hex('01 02 03 04') },
        ]);
        // Prefixes that end on a field boundary are valid messages themselves.
        const boundaries = new Set([0, 3, 8]);
        for (let n = 0; n < whole.length; n++) {
            if (boundaries.has(n)) continue;
            throws(() => decode(whole.subarray(0, n)), `prefix of ${n} bytes`);
        }
    });

    for (const wire of [3, 4, 6, 7]) {
        it(`throws on wire type ${wire}`, () => {
            throws(() => decode(new Uint8Array([(1 << 3) | wire, 0x00])));
            throws(() => encode([{ field: 1, wire, value: 0 }]));
        });
    }

    it('throws on field number zero', () => {
        throws(() => decode(hex('00 00')));
        throws(() => encode([{ field: 0, wire: 0, value: 0 }]));
    });

    it('throws on a length that exceeds the safe integer range', () => {
        throws(() => decode(hex('0a ff ff ff ff ff ff ff ff ff 01')));
    });

    it('throws when the input is not a Uint8Array', () => {
        throws(() => decode('0801'));
        throws(() => decode(null));
    });
});

// ===================================================================
//  Encoder input handling
// ===================================================================
describe('protobuf encode', () => {
    it('infers the wire type when it is omitted', () => {
        deepStrictEqual(encode([{ field: 1, value: 150 }]), hex('08 96 01'));
        deepStrictEqual(encode([{ field: 1, value: 150n }]), hex('08 96 01'));
        deepStrictEqual(encode([{ field: 2, value: hex('01 02') }]), hex('12 02 01 02'));
        deepStrictEqual(encode([{ field: 2, value: 'abc' }]), hex('12 03 61 62 63'));
    });

    it('encodes strings as UTF-8', () => {
        deepStrictEqual(encode([{ field: 1, wire: 2, value: 'hé✓' }]),
                        hex('0a 06 68 c3 a9 e2 9c 93'));
    });

    it('rejects varints that are negative, fractional or too large', () => {
        throws(() => encode([{ field: 1, wire: 0, value: -1 }]));
        throws(() => encode([{ field: 1, wire: 0, value: -1n }]));
        throws(() => encode([{ field: 1, wire: 0, value: 1.5 }]));
        throws(() => encode([{ field: 1, wire: 0, value: 2 ** 53 }]));
        throws(() => encode([{ field: 1, wire: 0, value: 2n ** 64n }]));
        throws(() => encode([{ field: 1, wire: 0, value: hex('01') }]));
    });

    it('rejects fixed values of the wrong size', () => {
        throws(() => encode([{ field: 1, wire: 1, value: hex('01 02 03 04') }]));
        throws(() => encode([{ field: 1, wire: 5, value: hex('01 02 03 04 05 06 07 08') }]));
        throws(() => encode([{ field: 1, wire: 5, value: 1 }]));
    });

    it('rejects values with no wire encoding', () => {
        throws(() => encode([{ field: 1, value: null }]));
        throws(() => encode([{ field: 1, value: { nested: true } }]));
        throws(() => encode([{ field: 1, wire: 2, value: 5 }]));
    });

    it('rejects field numbers out of range', () => {
        throws(() => encode([{ field: 2 ** 29, value: 0 }]));
        throws(() => encode([{ field: 1.5, value: 0 }]));
        throws(() => encode([{ value: 0 }]));
    });
});

// ===================================================================
//  get / getAll
// ===================================================================
describe('protobuf get / getAll', () => {
    const fields = [
        { field: 1, wire: 0, value: 5 },
        { field: 2, wire: 2, value: hex('aa') },
        { field: 1, wire: 0, value: 6 },
        { field: 3, wire: 0, value: 0 },
    ];

    it('get returns the first value of a field', () => {
        strictEqual(get(fields, 1), 5);
        deepStrictEqual(get(fields, 2), hex('aa'));
    });

    it('get returns a falsy value rather than undefined', () => {
        strictEqual(get(fields, 3), 0);
    });

    it('get returns undefined for an absent field', () => {
        strictEqual(get(fields, 9), undefined);
    });

    it('getAll returns every value in order', () => {
        deepStrictEqual(getAll(fields, 1), [5, 6]);
        deepStrictEqual(getAll(fields, 2), [hex('aa')]);
        deepStrictEqual(getAll(fields, 9), []);
    });
});
