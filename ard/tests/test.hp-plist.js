/*
 * Unit tests for the binary property list subset codec
 *
 * Run: node --test ard/tests/test.hp-plist.js
 *
 * All vectors hold synthetic content. The PY_* vectors come from Python's
 * plistlib:
 *
 *   python3 -c "import plistlib; print(plistlib.dumps(
 *       {'alpha': bytes(range(20)), 'beta': 'hello', 'gamma': 5, 'delta': 70000},
 *       fmt=plistlib.FMT_BINARY, sort_keys=False).hex())"
 *
 * APPLE_FOUR comes from Apple's own encoder: the same kind of dictionary
 * written as XML, then `plutil -convert binary1`.
 *
 * Checked by hand while developing (not repeated here, it needs python3 and
 * macOS): plistlib.loads() and `plutil -lint` / `plutil -p` read the output
 * of encode() for dictionaries with data up to 300 bytes, ASCII and UTF-16
 * strings, integers of every width, 130 keys, and no keys.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import { decode, encode } from '../hp/plist.js';

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g) || [];
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// Helper: deterministic synthetic bytes
function pattern(length, mul, add) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (i * mul + add) & 0xff;
    return out;
}

// Helper: frame raw objects into a property list with chosen field widths.
// The codec under test never sees this code path, so it can build layouts
// (2-byte refs, 3- and 4-byte offsets) that Python does not emit for small
// inputs, and deliberately broken ones.
function build(objects, { offsetSize = 1, refSize = 1, top = 0, count, tableAt } = {}) {
    const parts = [hex('62 70 6c 69 73 74 30 30')];
    const offsets = [];
    let pos = 8;
    for (const obj of objects) {
        offsets.push(pos);
        parts.push(Uint8Array.from(obj));
        pos += obj.length;
    }
    const table = [];
    for (const off of offsets) {
        for (let i = offsetSize - 1; i >= 0; i--) table.push(Math.floor(off / 2 ** (8 * i)) & 0xff);
    }
    parts.push(Uint8Array.from(table));
    const trailer = new Uint8Array(32);
    const dv = new DataView(trailer.buffer);
    trailer[6] = offsetSize;
    trailer[7] = refSize;
    dv.setUint32(12, count === undefined ? objects.length : count);
    dv.setUint32(20, top);
    dv.setUint32(28, tableAt === undefined ? pos : tableAt);
    parts.push(trailer);

    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// Helper: ASCII string object
function str(s) {
    return [0x50 | s.length, ...Array.from(s, c => c.charCodeAt(0))];
}

// {'alpha': bytes(range(20)), 'beta': 'hello', 'gamma': 5, 'delta': 70000}
const PY_FOUR = hex(
    '62706c6973743030d4010203040506070855616c70686154626574615567616d' +
    '6d615564656c74614f1014000102030405060708090a0b0c0d0e0f1011121355' +
    '68656c6c6f100512000111700811171c22283f45470000000000000101000000' +
    '00000000090000000000000000000000000000004c');
const FOUR = { alpha: pattern(20, 1, 0), beta: 'hello', gamma: 5, delta: 70000 };

// {'blob': bytes((i * 7 + 3) & 0xff for i in range(300)), 'kind': 'synthetic', 'count': 3}
// A 300-byte value needs a 2-byte length and 2-byte offset table entries.
const PY_LONG = hex(
    '62706c6973743030d301020304050654626c6f62546b696e6455636f756e744f' +
    '11012c030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7' +
    'ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7' +
    'aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b72798087' +
    '8e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b52596067' +
    '6e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b32394047' +
    '4e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b12192027' +
    '2e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f90007' +
    '0e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7' +
    'eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7' +
    'ced5dce3eaf1f8ff060d141b2229305973796e74686574696310030008000f00' +
    '140019001f014f01590000000000000201000000000000000700000000000000' +
    '00000000000000015b');
const LONG = { blob: pattern(300, 7, 3), kind: 'synthetic', count: 3 };

// {'name': 'héllo ✓', 'long': 'a string longer than fourteen',
//  'i1': 255, 'i2': 65535, 'i4': 4294967295, 'i8': 1099511627776}
// A UTF-16 string, an ASCII string with a length marker, every integer width.
const PY_MIXED = hex(
    '62706c6973743030d60102030405060708090a0b0c546e616d65546c6f6e6752' +
    '693152693252693452693867006800e9006c006c006f002027135f101d612073' +
    '7472696e67206c6f6e676572207468616e20666f75727465656e10ff11ffff12' +
    'ffffffff13000001000000000008151a1f2225282b3a5a5c5f64000000000000' +
    '0101000000000000000d0000000000000000000000000000006d');
const MIXED = {
    name: 'héllo ✓',
    long: 'a string longer than fourteen',
    i1: 255,
    i2: 65535,
    i4: 4294967295,
    i8: 1099511627776,
};

// {'k%02d' % i: i for i in range(16)} — the dictionary count needs the 0xF form
const PY_SIXTEEN = hex(
    '62706c6973743030df10100102030405060708090a0b0c0d0e0f101112131415' +
    '161718191a1b1c1d1e1f20536b3030536b3031536b3032536b3033536b303453' +
    '6b3035536b3036536b3037536b3038536b3039536b3130536b3131536b313253' +
    '6b3133536b3134536b3135100010011002100310041005100610071008100910' +
    '0a100b100c100d100e100f082b2f33373b3f43474b4f53575b5f63676b6d6f71' +
    '737577797b7d7f81838587890000000000000101000000000000002100000000' +
    '00000000000000000000008b');
const SIXTEEN = {};
for (let i = 0; i < 16; i++) SIXTEEN['k' + String(i).padStart(2, '0')] = i;

// {'a': 'same', 'b': 'same', 'c': 7, 'd': 7} — equal values share one object
const PY_SHARED = hex(
    '62706c6973743030d4010203040505060651615162516351645473616d651007' +
    '0811131517191e00000000000001010000000000000007000000000000000000' +
    '00000000000020');
const SHARED = { a: 'same', b: 'same', c: 7, d: 7 };

// {'first': 32 bytes, 'second': 48 bytes, 'title': 'synth\u00e9tique', 'level': 300}
// Apple orders keys by hash, so the objects are not in the order written above.
const APPLE_FOUR = hex(
    '62706c6973743030d40102030405060708556669727374557469746c65556c65' +
    '76656c567365636f6e644f10200104070a0d101316191c1f2225282b2e313437' +
    '3a3d404346494c4f5255585b5e6b00730079006e0074006800e9007400690071' +
    '0075006511012c4f103002070c11161b20252a2f34393e43484d52575c61666b' +
    '70757a7f84898e93989da2a7acb1b6bbc0c5cacfd4d9dee3e8ed0811171d232a' +
    '4d64670000000000000101000000000000000900000000000000000000000000' +
    '00009a');

// ===================================================================
//  Decode: vectors from other encoders
// ===================================================================
describe('plist decode (plistlib and plutil vectors)', () => {
    it('decodes a dictionary written by Apple\'s encoder', () => {
        deepStrictEqual(decode(APPLE_FOUR), {
            first: pattern(32, 3, 1),
            second: pattern(48, 5, 2),
            title: 'synth\u00e9tique',
            level: 300,
        });
    });


    it('decodes a four-key dictionary of data, string and integers', () => {
        deepStrictEqual(decode(PY_FOUR), FOUR);
    });

    it('decodes data longer than 255 bytes with 2-byte offsets', () => {
        strictEqual(PY_LONG[PY_LONG.length - 26], 2);    // offset int size
        deepStrictEqual(decode(PY_LONG), LONG);
    });

    it('decodes UTF-16 and long ASCII strings and every integer width', () => {
        deepStrictEqual(decode(PY_MIXED), MIXED);
    });

    it('decodes a dictionary of more than 14 keys', () => {
        deepStrictEqual(decode(PY_SIXTEEN), SIXTEEN);
    });

    it('decodes values that share one object', () => {
        deepStrictEqual(decode(PY_SHARED), SHARED);
    });

    it('returns plain Uint8Array copies for data', () => {
        const input = PY_FOUR.slice();
        const out = decode(input);
        strictEqual(Object.getPrototypeOf(out.alpha), Uint8Array.prototype);
        input.fill(0);
        deepStrictEqual(out.alpha, FOUR.alpha);
    });
});

// ===================================================================
//  Decode: hand-built layouts
// ===================================================================
describe('plist decode (hand-built)', () => {
    const objects = [
        [0xd2, 0, 1, 0, 2, 0, 3, 0, 4],     // dict, 2 pairs, 2-byte refs
        str('id'),
        str('tag'),
        [0x11, 0x01, 0x2c],                 // 300
        [0x42, 0xca, 0xfe],
    ];
    const expected = { id: 300, tag: hex('ca fe') };

    it('decodes 2-byte object refs', () => {
        deepStrictEqual(decode(build(objects, { refSize: 2 })), expected);
    });

    for (const offsetSize of [2, 3, 4]) {
        it(`decodes ${offsetSize}-byte offset table entries`, () => {
            deepStrictEqual(decode(build(objects, { refSize: 2, offsetSize })), expected);
        });
    }

    it('decodes a top object that is not object 0', () => {
        const reordered = [str('n'), [0x10, 0x09], [0xd1, 0, 1]];
        deepStrictEqual(decode(build(reordered, { top: 2 })), { n: 9 });
    });

    it('decodes an empty dictionary', () => {
        deepStrictEqual(decode(build([[0xd0]])), {});
    });

    it('decodes the length extension on a short value', () => {
        // 0x4F 0x10 0x02: data of length 2, written the long way
        deepStrictEqual(decode(build([[0xd1, 1, 2], str('k'), [0x4f, 0x10, 0x02, 0xab, 0xcd]])),
                        { k: hex('ab cd') });
    });

    it('decodes length extensions of 2, 4 and 8 bytes', () => {
        for (const ext of [[0x11, 0, 2], [0x12, 0, 0, 0, 2], [0x13, 0, 0, 0, 0, 0, 0, 0, 2]]) {
            deepStrictEqual(decode(build([[0xd1, 1, 2], str('k'), [0x4f, ...ext, 0xab, 0xcd]])),
                            { k: hex('ab cd') });
        }
    });

    it('decodes an 8-byte integer at the safe integer limit', () => {
        const big = [0x13, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        deepStrictEqual(decode(build([[0xd1, 1, 2], str('k'), big])),
                        { k: Number.MAX_SAFE_INTEGER });
    });

    it('keeps "__proto__" as an ordinary key', () => {
        const out = decode(build([[0xd1, 1, 2], str('__proto__'), [0x41, 0x01]]));
        strictEqual(Object.getPrototypeOf(out), Object.prototype);
        deepStrictEqual(Object.keys(out), ['__proto__']);
    });
});

// ===================================================================
//  Decode: malformed and unsupported input
// ===================================================================
describe('plist decode (malformed)', () => {
    const good = [[0xd1, 1, 2], str('k'), [0x10, 0x05]];

    it('accepts the baseline used by the cases below', () => {
        deepStrictEqual(decode(build(good)), { k: 5 });
    });

    it('throws on every truncation of a valid list', () => {
        for (let n = 0; n < PY_FOUR.length; n++) {
            throws(() => decode(PY_FOUR.subarray(0, n)), `prefix of ${n} bytes`);
        }
    });

    it('throws on bad magic', () => {
        for (const magic of ['bplist01', 'xplist00', '<?xml ve']) {
            const bad = PY_FOUR.slice();
            for (let i = 0; i < 8; i++) bad[i] = magic.charCodeAt(i);
            throws(() => decode(bad), magic);
        }
    });

    it('throws on a bad offset int size', () => {
        for (const offsetSize of [0, 5, 8]) {
            const bad = build(good);
            bad[bad.length - 26] = offsetSize;
            throws(() => decode(bad), `offset int size ${offsetSize}`);
        }
    });

    it('throws on a bad object ref size', () => {
        for (const refSize of [0, 3, 4]) {
            const bad = build(good);
            bad[bad.length - 25] = refSize;
            throws(() => decode(bad), `object ref size ${refSize}`);
        }
    });

    it('throws on a bad object count', () => {
        throws(() => decode(build(good, { count: 0 })));
        throws(() => decode(build(good, { count: 4 })));
        throws(() => decode(build(good, { count: 0xffffffff })));
        const high = build(good);
        high[high.length - 24] = 1;     // top byte of the 64-bit count
        throws(() => decode(high));
    });

    it('throws on a top object outside the object table', () => {
        throws(() => decode(build(good, { top: 3 })));
        throws(() => decode(build(good, { top: 0xffffffff })));
    });

    it('throws on a bad offset table offset', () => {
        const at = 8 + 3 + 2 + 2;       // where the table really is
        throws(() => decode(build(good, { tableAt: 0 })));
        throws(() => decode(build(good, { tableAt: 8 })));
        throws(() => decode(build(good, { tableAt: at - 1 })));
        throws(() => decode(build(good, { tableAt: at + 1 })));
        throws(() => decode(build(good, { tableAt: at + 3 })));
        throws(() => decode(build(good, { tableAt: 0xffffffff })));
    });

    it('throws on trailing bytes after the trailer', () => {
        const whole = build(good);
        const longer = new Uint8Array(whole.length + 1);
        longer.set(whole);
        throws(() => decode(longer));
    });

    it('throws on an object offset outside the object area', () => {
        const bad = build(good);
        const table = bad.length - 32 - 3;
        bad[table + 2] = 0;             // inside the header
        throws(() => decode(bad));
        bad[table + 2] = table;         // inside the offset table
        throws(() => decode(bad));
        bad[table + 2] = 0xff;          // past the end
        throws(() => decode(bad));
    });

    it('throws on an object ref outside the object table', () => {
        throws(() => decode(build([[0xd1, 1, 3], str('k'), [0x10, 0x05]])));
        throws(() => decode(build([[0xd1, 9, 2], str('k'), [0x10, 0x05]])));
    });

    it('throws when the top object is not a dictionary', () => {
        throws(() => decode(build([str('k')])));
        throws(() => decode(build([[0xa1, 1], str('k')])));
        throws(() => decode(build(good, { top: 2 })));
    });

    it('throws on a key that is not a string', () => {
        throws(() => decode(build([[0xd1, 1, 2], [0x10, 0x01], [0x10, 0x05]])));
        throws(() => decode(build([[0xd1, 1, 2], [0x41, 0x6b], [0x10, 0x05]])));
    });

    it('throws on a repeated key', () => {
        throws(() => decode(build([[0xd2, 1, 1, 2, 2], str('k'), [0x10, 0x05]])));
        throws(() => decode(build([[0xd2, 1, 3, 2, 2], str('k'), [0x10, 0x05], str('k')])));
    });

    it('throws on unsupported value types', () => {
        const values = {
            'null': [0x00],
            'false': [0x08],
            'true': [0x09],
            'real': [0x23, 0, 0, 0, 0, 0, 0, 0, 0],
            'date': [0x33, 0, 0, 0, 0, 0, 0, 0, 0],
            'uid': [0x80, 0x01],
            'array': [0xa0],
            'set': [0xc0],
            'dictionary': [0xd0],
            '16-byte integer': [0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        };
        for (const [name, value] of Object.entries(values)) {
            throws(() => decode(build([[0xd1, 1, 2], str('k'), value])), name);
        }
    });

    it('throws on a dictionary that contains itself', () => {
        throws(() => decode(build([[0xd1, 1, 0], str('k')])));
    });

    it('throws on a negative integer', () => {
        const minusOne = [0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        throws(() => decode(build([[0xd1, 1, 2], str('k'), minusOne])));
    });

    it('throws on an integer past the safe range', () => {
        const big = [0x13, 0x00, 0x20, 0, 0, 0, 0, 0, 0];    // 2^53
        throws(() => decode(build([[0xd1, 1, 2], str('k'), big])));
    });

    it('throws when a value runs past the object area', () => {
        // The offset table and trailer follow, so most of these overruns stay
        // inside the file and only the object area check catches them.
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x44, 1, 2]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x4f, 0x10, 0x40, 1, 2]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x55, 0x61]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x62, 0x00, 0x61]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x11, 0x01]])));
        throws(() => decode(build([str('k'), [0x10, 0x05], [0xd3, 0, 1]], { top: 2 })));
    });

    it('throws on a bad length extension', () => {
        // The extension must be an integer object; 0x50 is a string marker.
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x4f, 0x50, 0x02, 0xab, 0xcd]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x4f, 0x14, 0x02, 0xab, 0xcd]])));
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x4f]])));
    });

    it('throws on a non-ASCII byte in an ASCII string', () => {
        throws(() => decode(build([[0xd1, 1, 2], str('k'), [0x51, 0xe9]])));
    });

    it('throws when the input is not a Uint8Array', () => {
        throws(() => decode('bplist00'));
        throws(() => decode(null));
        throws(() => decode(PY_FOUR.buffer));
    });
});

// ===================================================================
//  Encode
// ===================================================================
describe('plist encode', () => {
    it('round trips a four-key dictionary', () => {
        const dict = {
            keys: pattern(40, 5, 1),        // longer than 14 bytes
            blob: pattern(300, 11, 2),      // longer than 255 bytes
            label: 'synthetic',
            version: 2,
        };
        deepStrictEqual(decode(encode(dict)), dict);
    });

    it('round trips short and empty values', () => {
        const dict = { d: pattern(14, 3, 0), e: new Uint8Array(0), s: '', z: 0 };
        deepStrictEqual(decode(encode(dict)), dict);
    });

    it('round trips integers at every width boundary', () => {
        const dict = {};
        const values = [0, 1, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER];
        values.forEach((v, i) => { dict['n' + i] = v; });
        deepStrictEqual(decode(encode(dict)), dict);
    });

    it('round trips a UTF-16 string value and key', () => {
        const dict = { 'clé': 'naïve ✓ 😀', plain: 'ascii' };
        deepStrictEqual(decode(encode(dict)), dict);
    });

    it('round trips a dictionary that needs 2-byte object refs', () => {
        const dict = {};
        for (let i = 0; i < 130; i++) dict['key' + i] = i * 1000;
        const encoded = encode(dict);
        strictEqual(encoded[encoded.length - 25], 2);    // object ref size
        deepStrictEqual(decode(encoded), dict);
    });

    it('round trips an empty dictionary', () => {
        deepStrictEqual(decode(encode({})), {});
    });

    // Byte-for-byte agreement with plistlib (sort_keys=False). Checked the
    // other way round while developing: plistlib.loads() reads the output of
    // encode() for each of these dictionaries.
    it('matches plistlib byte for byte', () => {
        deepStrictEqual(encode(FOUR), PY_FOUR);
        deepStrictEqual(encode(LONG), PY_LONG);
        deepStrictEqual(encode(MIXED), PY_MIXED);
        deepStrictEqual(encode(SIXTEEN), PY_SIXTEEN);
    });

    it('lays out header, objects, offset table and trailer', () => {
        const out = encode({ k: 5 });
        deepStrictEqual(out, hex(
            '62 70 6c 69 73 74 30 30' +     // "bplist00"
            'd1 01 02' +                    // dict: key ref 1, value ref 2
            '51 6b' +                       // "k"
            '10 05' +                       // 5
            '08 0b 0d' +                    // offset table
            '00 00 00 00 00 00 01 01' +     // offset int size 1, object ref size 1
            '00 00 00 00 00 00 00 03' +     // 3 objects
            '00 00 00 00 00 00 00 00' +     // top object 0
            '00 00 00 00 00 00 00 0f'));    // offset table at 15
    });

    it('rejects unsupported values', () => {
        throws(() => encode({ k: -1 }));
        throws(() => encode({ k: 1.5 }));
        throws(() => encode({ k: 2 ** 53 }));
        throws(() => encode({ k: NaN }));
        throws(() => encode({ k: null }));
        throws(() => encode({ k: undefined }));
        throws(() => encode({ k: true }));
        throws(() => encode({ k: [1, 2] }));
        throws(() => encode({ k: { nested: 1 } }));
        throws(() => encode({ k: 5n }));
    });

    it('rejects a non-object argument', () => {
        throws(() => encode(null));
        throws(() => encode('text'));
        throws(() => encode([1]));
        throws(() => encode(new Uint8Array(4)));
    });
});
