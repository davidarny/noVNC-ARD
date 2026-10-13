/*
 * Unit tests for the High Performance video assembler: RTP packets in,
 * HEVC or H.264 pictures out in decoding order. Every packet here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-rtp-video.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, doesNotThrow, strictEqual } from 'node:assert';

import { VideoAssembler } from '../hp/rtp-video.js';

const BASE = 0x5a000010;

// HEVC NAL unit types
const TRAIL = 1, IDR = 20, VPS = 32, SPS = 33, PPS = 34;

// Helper: hex string → Uint8Array
function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g);
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

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

// Fake NAL unit: a real two-byte header for `type`, then `size` filler bytes
function nal(type, size, seed = 0) {
    const out = new Uint8Array(2 + size);
    out[0] = type << 1;
    out[1] = 0x01;
    for (let i = 0; i < size; i++) out[2 + i] = (type * 31 + seed * 17 + i * 7 + 1) & 0xff;
    return out;
}

// --- payload builders (Section 14.10 layouts) ---

function single(unit, don) {
    return concat(unit.subarray(0, 2), u16(don), unit.subarray(2));
}

function aggregation(units, don) {
    const chunks = [[48 << 1, 0x01], u16(don)];
    for (const unit of units) chunks.push(u16(unit.length), unit);
    return concat(...chunks);
}

function fragments(unit, don, n) {
    const body = unit.subarray(2);
    const step = Math.ceil(body.length / n);
    const out = [];
    for (let i = 0; i < n; i++) {
        const flags = (i === 0 ? 0x80 : 0) | (i === n - 1 ? 0x40 : 0);
        out.push(concat(
            [(unit[0] & 0x81) | (49 << 1), unit[1]],
            [flags | ((unit[0] >> 1) & 0x3f)],
            u16(don),
            body.subarray(i * step, (i + 1) * step)));
    }
    return out;
}

function annexB(...units) {
    return concat(...units.flatMap(unit => [[0, 0, 0, 1], unit]));
}

function extension(count, frame) {
    return Uint8Array.of(0x93, 0x11, 0x00, 0x01, ...u16(count), ...u16(frame));
}

// One picture as RTP packets: consecutive sequence numbers, the packet count
// in every extension, marker on the last
function picture({ stripe = 0, seq = 0, frame = 0 }, payloads) {
    return payloads.map((payload, i) => ({
        ssrc: BASE + stripe,
        seq: (seq + i) & 0xffff,
        marker: i === payloads.length - 1,
        extension: extension(payloads.length, frame),
        payload,
    }));
}

function harness(options = {}) {
    const pictures = [];
    const stalls = [];
    const asm = new VideoAssembler({
        baseSsrc: BASE,
        stripes: 4,
        onPicture: p => pictures.push(p),
        onStall: s => stalls.push(s),
        ...options,
    });
    const push = (packets, now = 0) => {
        for (const p of packets) asm.push(p, now);
    };
    return { asm, pictures, stalls, push };
}

// Single-packet pictures for tests about ordering
function keyPicture(don, where = {}) {
    return picture(where, [single(nal(IDR, 12, don), don)]);
}

function trailPicture(don, where = {}) {
    return picture(where, [single(nal(TRAIL, 9, don), don)]);
}

const PARAMS = [nal(VPS, 5), nal(SPS, 11), nal(PPS, 4)];

// ===================================================================
//  Payload formats
// ===================================================================
describe('VideoAssembler payload formats', () => {
    it('emits a single NAL unit picture', () => {
        const h = harness();
        const idr = nal(IDR, 30);
        h.push(picture({ seq: 700, frame: 9 }, [single(idr, 4000)]));

        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0], {
            don: 4000, stripe: 0, frame: 9, key: true, format: 'hevc', data: annexB(idr),
        });
        deepStrictEqual(h.asm.stats, {
            packets: 1, ignored: 0, malformed: 0, duplicates: 0, pictures: 1, discarded: 0,
        });
    });

    it('accepts a NAL unit that is only a header', () => {
        const h = harness();
        const idr = nal(IDR, 0);
        h.push(picture({}, [single(idr, 1)]));
        deepStrictEqual(h.pictures[0].data, annexB(idr));
    });

    it('emits an aggregation-only picture (parameter sets and a small slice)', () => {
        const h = harness();
        const idr = nal(IDR, 20);
        h.push(picture({ frame: 1 }, [aggregation([...PARAMS, idr], 12)]));

        strictEqual(h.pictures.length, 1);
        strictEqual(h.pictures[0].key, true);
        strictEqual(h.pictures[0].don, 12);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, idr));
    });

    it('joins parameter sets and a fragmented slice of the same picture', () => {
        const h = harness();
        const idr = nal(IDR, 4000);
        const packets = picture({ seq: 100, frame: 3 }, [
            aggregation(PARAMS, 500),
            ...fragments(idr, 500, 5),
        ]);
        strictEqual(packets.length, 6);

        h.push(packets.slice(0, 5));
        strictEqual(h.pictures.length, 0, 'not complete before the last packet');
        h.push(packets.slice(5));

        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0], {
            don: 500, stripe: 0, frame: 3, key: true, format: 'hevc', data: annexB(...PARAMS, idr),
        });
    });

    it('reports a picture without an IRAP unit as not key', () => {
        const h = harness();
        const slice = nal(TRAIL, 300);
        h.push(keyPicture(7));
        h.push(picture({ stripe: 1, seq: 40 }, [
            aggregation(PARAMS, 8),
            ...fragments(slice, 8, 2),
        ]));

        strictEqual(h.pictures.length, 2);
        strictEqual(h.pictures[1].key, false);
        strictEqual(h.pictures[1].stripe, 1);
        deepStrictEqual(h.pictures[1].data, annexB(...PARAMS, slice));
    });

    it('orders fragments delivered out of order', () => {
        const h = harness();
        const idr = nal(IDR, 900);
        const packets = picture({ seq: 20 }, [
            aggregation(PARAMS, 77),
            ...fragments(idr, 77, 6),
        ]);
        for (const i of [4, 0, 6, 2, 5, 1, 3]) h.push([packets[i]]);

        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, idr));
    });

    it('rebuilds the NAL header of a fragmented unit exactly', () => {
        // Payload header 63 0a: type 49, with the forbidden-zero bit clear, the
        // top layer bit set and a second byte of 0a. Fragment headers 94, 14,
        // 54: start, middle, end of a unit of type 20. Order number 0x1234.
        const h = harness();
        h.push(picture({ seq: 9 }, [
            hex('630a 94 1234 a1a2a3'),
            hex('630a 14 1234 b1b2'),
            hex('630a 54 1234 c1'),
        ]));

        strictEqual(h.pictures.length, 1);
        strictEqual(h.pictures[0].don, 0x1234);
        strictEqual(h.pictures[0].key, true);
        deepStrictEqual(h.pictures[0].data, hex('00000001 290a a1a2a3 b1b2 c1'));
    });

    it('keeps the forbidden-zero bit of the payload header', () => {
        const h = harness();
        h.push(picture({}, [hex('e201 94 0005 aa'), hex('e201 54 0005 bb')]));
        deepStrictEqual(h.pictures[0].data, hex('00000001 a801 aa bb'));
    });

    it('orders a fragmented picture whose sequence numbers wrap', () => {
        const h = harness();
        const idr = nal(IDR, 700);
        const packets = picture({ seq: 65533 }, [
            aggregation(PARAMS, 3),
            ...fragments(idr, 3, 5),
        ]);
        deepStrictEqual(packets.map(p => p.seq), [65533, 65534, 65535, 0, 1, 2]);
        for (const i of [3, 5, 1, 0, 4, 2]) h.push([packets[i]]);

        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, idr));
    });
});

// ===================================================================
//  Stripes and decoding order
// ===================================================================
describe('VideoAssembler ordering', () => {
    it('emits four interleaved stripes in decoding order', () => {
        const h = harness();
        const idr = nal(IDR, 600);
        const slices = [1, 2, 3, 4, 5].map(i => nal(TRAIL, 200 + i, i));

        // Frame 50: all four stripes, order numbers 1000-1003.
        // Frame 51: stripes 1 and 3 only, order numbers 1004 and 1005.
        const pics = [
            picture({ stripe: 0, seq: 10, frame: 50 },
                    [aggregation(PARAMS, 1000), ...fragments(idr, 1000, 3)]),
            picture({ stripe: 1, seq: 20, frame: 50 },
                    [aggregation([...PARAMS, slices[0]], 1001)]),
            picture({ stripe: 2, seq: 30, frame: 50 },
                    [aggregation(PARAMS, 1002), ...fragments(slices[1], 1002, 2)]),
            picture({ stripe: 3, seq: 40, frame: 50 },
                    [aggregation([...PARAMS, slices[2]], 1003)]),
            picture({ stripe: 1, seq: 21, frame: 51 }, [single(slices[3], 1004)]),
            picture({ stripe: 3, seq: 41, frame: 51 }, fragments(slices[4], 1005, 2)),
        ];
        for (const i of [3, 5, 1, 4, 2, 0]) h.push(pics[i]);

        deepStrictEqual(h.pictures.map(p => [p.don, p.stripe, p.frame, p.key]), [
            [1000, 0, 50, true],
            [1001, 1, 50, false],
            [1002, 2, 50, false],
            [1003, 3, 50, false],
            [1004, 1, 51, false],
            [1005, 3, 51, false],
        ]);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, idr));
        deepStrictEqual(h.pictures[2].data, annexB(...PARAMS, slices[1]));
        deepStrictEqual(h.pictures[4].data, annexB(slices[3]));
        deepStrictEqual(h.pictures[5].data, annexB(slices[4]));
        strictEqual(h.stalls.length, 0);
    });

    it('emits as soon as the expected picture completes, packets interleaved', () => {
        const h = harness();
        const a = picture({ stripe: 0, seq: 5 }, fragments(nal(IDR, 90), 60, 3));
        const b = picture({ stripe: 1, seq: 5 }, fragments(nal(TRAIL, 90), 61, 3));

        h.push([b[0], a[0], b[1], a[1], b[2]]);
        strictEqual(h.pictures.length, 0);
        h.push([a[2]]);
        deepStrictEqual(h.pictures.map(p => [p.don, p.stripe]), [[60, 0], [61, 1]]);
    });

    it('ignores a duplicated packet', () => {
        const h = harness();
        const idr = nal(IDR, 400);
        const packets = picture({ seq: 300 }, [
            aggregation(PARAMS, 9),
            ...fragments(idr, 9, 3),
        ]);
        h.push([packets[0], packets[1], packets[1], packets[0], packets[2]]);
        strictEqual(h.pictures.length, 0, 'duplicates do not count towards completion');
        h.push([packets[3]]);

        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, idr));
        strictEqual(h.asm.stats.duplicates, 2);
        strictEqual(h.asm.stats.packets, 6);
    });

    it('emits a picture once when all of it is delivered again', () => {
        const h = harness();
        const first = keyPicture(30);
        const second = picture({ stripe: 2, seq: 8 }, fragments(nal(TRAIL, 50), 31, 2));
        h.push(first);
        h.push(second);
        h.push(first);
        h.push(second);

        deepStrictEqual(h.pictures.map(p => p.don), [30, 31]);
        strictEqual(h.asm.stats.duplicates, 3);
        strictEqual(h.asm.stats.pictures, 2);
    });

    it('ignores a duplicate of a picture that is complete and waiting', () => {
        const h = harness();
        h.push(keyPicture(1));
        h.push(trailPicture(3));
        h.push(trailPicture(3));
        strictEqual(h.asm.stats.duplicates, 1);
        h.push(trailPicture(2));
        deepStrictEqual(h.pictures.map(p => p.don), [1, 2, 3]);
    });

    it('ignores packets from an unknown SSRC', () => {
        const h = harness();
        const below = keyPicture(5)[0];
        const above = keyPicture(5)[0];
        below.ssrc = BASE - 1;
        above.ssrc = BASE + 4;
        h.push([below, above, { ...keyPicture(5)[0], ssrc: undefined }]);

        strictEqual(h.pictures.length, 0);
        strictEqual(h.asm.stats.ignored, 3);

        h.push(keyPicture(5, { stripe: 3 }));
        strictEqual(h.pictures.length, 1);
        strictEqual(h.pictures[0].stripe, 3);
    });

    it('ignores packets without an 8-byte extension', () => {
        const h = harness();
        const base = keyPicture(5)[0];
        h.push([
            { ...base, extension: new Uint8Array(0) },
            { ...base, extension: base.extension.subarray(0, 4) },
            { ...base, extension: new Uint8Array(12) },
            { ...base, extension: undefined },
        ]);
        strictEqual(h.pictures.length, 0);
        strictEqual(h.asm.stats.ignored, 4);
        strictEqual(h.asm.stats.malformed, 0);
    });

    it('discards pictures before the first key picture', () => {
        const h = harness();
        const partial = picture({ stripe: 3, seq: 70 }, fragments(nal(TRAIL, 40), 197, 2));
        h.push(trailPicture(198, { stripe: 1 }));
        h.push([partial[0]]);
        h.push(trailPicture(199, { stripe: 2 }));
        h.push(trailPicture(201, { stripe: 1, seq: 1 }));
        h.push(trailPicture(202, { stripe: 2, seq: 1 }));
        strictEqual(h.pictures.length, 0, 'nothing before the key picture');

        h.push(keyPicture(200));
        deepStrictEqual(h.pictures.map(p => [p.don, p.key]),
                        [[200, true], [201, false], [202, false]]);
        strictEqual(h.asm.stats.discarded, 3);

        // The rest of a discarded picture, arriving late, is dropped
        h.push([partial[1]]);
        strictEqual(h.pictures.length, 3);
        strictEqual(h.asm.stats.ignored, 1);
        strictEqual(h.stalls.length, 0);
    });

    it('unwraps the decoding order number across 65535 → 0', () => {
        const h = harness();
        h.push(keyPicture(65534, { seq: 0 }));
        h.push(trailPicture(65535, { seq: 1 }));
        h.push(trailPicture(0, { seq: 2 }));
        h.push(trailPicture(1, { seq: 3 }));

        deepStrictEqual(h.pictures.map(p => p.don), [65534, 65535, 65536, 65537]);
        deepStrictEqual(h.pictures.map(p => p.data), [
            annexB(nal(IDR, 12, 65534)),
            annexB(nal(TRAIL, 9, 65535)),
            annexB(nal(TRAIL, 9, 0)),
            annexB(nal(TRAIL, 9, 1)),
        ]);
    });

    it('orders pictures scrambled across the wrap', () => {
        const h = harness();
        h.push(keyPicture(65534));
        for (const don of [1, 0, 2, 65535]) h.push(trailPicture(don));
        deepStrictEqual(h.pictures.map(p => p.don), [65534, 65535, 65536, 65537, 65538]);
    });

    it('keeps the number non-negative when the key picture arrives after the wrap', () => {
        const h = harness();
        for (const don of [0, 65535, 65533]) h.push(trailPicture(don));
        h.push(keyPicture(65534));

        deepStrictEqual(h.pictures.map(p => p.don), [65534, 65535, 65536]);
        deepStrictEqual(h.pictures.map(p => p.don & 0xffff), [65534, 65535, 0]);
        strictEqual(h.asm.stats.discarded, 1);

        h.push(trailPicture(1));
        strictEqual(h.pictures[3].don, 65537);
    });

    it('keeps unwrapping over many cycles', () => {
        const h = harness();
        const first = 65000;
        const total = 140000;
        h.push(keyPicture(first));
        for (let i = 1; i < total; i++) h.push(trailPicture((first + i) & 0xffff));

        strictEqual(h.pictures.length, total);
        strictEqual(h.pictures[total - 1].don, first + total - 1);
        strictEqual(h.pictures.every((p, i) => p.don === first + i), true);
    });
});

// ===================================================================
//  Stall
// ===================================================================
describe('VideoAssembler stall', () => {
    it('fires onStall once when a picture is missing for longer than stallMs', () => {
        const h = harness();
        h.push(keyPicture(10), 1000);
        h.push(trailPicture(12), 1010);          // 11 never arrives
        h.push(trailPicture(13), 1100);
        strictEqual(h.pictures.length, 1);

        h.asm.tick(1210);                        // waited exactly 200 ms
        strictEqual(h.stalls.length, 0);
        h.asm.tick(1211);
        deepStrictEqual(h.stalls, [{ expectedDon: 11, buffered: 2 }]);

        // Nothing more is emitted, not even the missing picture
        h.push(trailPicture(11), 1220);
        h.push(trailPicture(14), 1230);
        h.asm.tick(5000);
        strictEqual(h.pictures.length, 1);
        strictEqual(h.stalls.length, 1);
        strictEqual(h.asm.stats.pictures, 1);
        strictEqual(h.asm.stats.ignored, 2);
    });

    it('detects the stall from push as well as tick', () => {
        const h = harness();
        h.push(keyPicture(10), 0);
        h.push(trailPicture(12), 10);
        h.push(trailPicture(13), 250);
        deepStrictEqual(h.stalls, [{ expectedDon: 11, buffered: 2 }]);
    });

    it('does not stall when the late picture arrives in time', () => {
        const h = harness();
        h.push(keyPicture(10), 0);
        h.push(trailPicture(12), 10);
        h.asm.tick(150);
        h.push(trailPicture(11), 190);
        h.asm.tick(1000);

        deepStrictEqual(h.pictures.map(p => p.don), [10, 11, 12]);
        strictEqual(h.stalls.length, 0);
    });

    it('does not stall on an incomplete picture with nothing waiting behind it', () => {
        const h = harness();
        const slow = picture({ stripe: 1 }, fragments(nal(TRAIL, 60), 11, 2));
        h.push(keyPicture(10), 0);
        h.push([slow[0]], 10);
        h.asm.tick(5000);
        strictEqual(h.stalls.length, 0);
        h.push([slow[1]], 5001);
        deepStrictEqual(h.pictures.map(p => p.don), [10, 11]);
    });

    it('honours stallMs', () => {
        const h = harness({ stallMs: 50 });
        h.push(keyPicture(10), 0);
        h.push(trailPicture(12), 0);
        h.asm.tick(50);
        strictEqual(h.stalls.length, 0);
        h.asm.tick(51);
        strictEqual(h.stalls.length, 1);
    });

    it('stalls when more than 512 pictures are buffered', () => {
        const h = harness();
        h.push(keyPicture(100), 0);
        for (let i = 0; i < 512; i++) h.push(trailPicture(102 + i), 0);
        strictEqual(h.stalls.length, 0);
        h.push(trailPicture(102 + 512), 0);
        deepStrictEqual(h.stalls, [{ expectedDon: 101, buffered: 513 }]);

        h.push(trailPicture(101), 0);
        strictEqual(h.pictures.length, 1);
    });

    it('stalls when no key picture arrives within 512 pictures', () => {
        const h = harness();
        for (let i = 0; i < 513; i++) h.push(trailPicture(i), i);
        deepStrictEqual(h.stalls, [{ expectedDon: null, buffered: 513 }]);
        h.push(keyPicture(513), 600);
        strictEqual(h.pictures.length, 0);
    });
});

// ===================================================================
//  Malformed input
// ===================================================================
describe('VideoAssembler malformed input', () => {
    // One packet claiming to be a whole picture, with any payload
    function pushRaw(h, payload) {
        const packet = picture({}, [payload])[0];
        doesNotThrow(() => h.asm.push(packet, 0));
    }

    it('drops an empty or very short payload', () => {
        const h = harness();
        pushRaw(h, new Uint8Array(0));
        pushRaw(h, hex('28'));
        pushRaw(h, hex('2801 00'));           // single NAL unit, order number cut short
        doesNotThrow(() => h.asm.push({ ...keyPicture(1)[0], payload: undefined }, 0));
        strictEqual(h.asm.stats.malformed, 4);
        strictEqual(h.pictures.length, 0);
    });

    it('drops a truncated fragment', () => {
        const h = harness();
        pushRaw(h, hex('6201 94 00'));        // order number cut short
        pushRaw(h, hex('6201'));
        strictEqual(h.asm.stats.malformed, 2);
        strictEqual(h.pictures.length, 0);
    });

    it('drops an aggregation whose size runs past the end', () => {
        const h = harness();
        const good = aggregation([...PARAMS, nal(IDR, 10)], 5);
        pushRaw(h, good.subarray(0, good.length - 1));
        pushRaw(h, hex('6001 0005 0009 4001 aabb'));   // says 9, has 4
        pushRaw(h, hex('6001 0005 0002 4001 00'));     // one stray byte after a unit
        pushRaw(h, hex('6001 0005 0000'));             // empty unit
        pushRaw(h, hex('6001 0005'));                  // no units at all
        strictEqual(h.asm.stats.malformed, 5);
        strictEqual(h.pictures.length, 0);

        // The intact packet still goes through afterwards
        pushRaw(h, good);
        strictEqual(h.pictures.length, 1);
        deepStrictEqual(h.pictures[0].data, annexB(...PARAMS, nal(IDR, 10)));
    });

    it('drops payload types above 49', () => {
        const h = harness();
        pushRaw(h, hex('6401 0001 aabbcc'));           // type 50
        pushRaw(h, hex('7e01 0001 aabbcc'));           // type 63
        strictEqual(h.asm.stats.malformed, 2);
    });

    it('drops a packet with a packet count of zero or a bad sequence number', () => {
        const h = harness();
        const packet = keyPicture(1)[0];
        doesNotThrow(() => {
            h.asm.push({ ...packet, extension: extension(0, 0) }, 0);
            h.asm.push({ ...packet, seq: 65536 }, 0);
            h.asm.push({ ...packet, seq: -1 }, 0);
            h.asm.push({ ...packet, seq: undefined }, 0);
        });
        strictEqual(h.asm.stats.malformed, 4);
        strictEqual(h.pictures.length, 0);
    });

    it('drops a packet that contradicts its picture', () => {
        const h = harness();
        const idr = nal(IDR, 80);
        const packets = picture({ seq: 4 }, fragments(idr, 6, 3));
        h.push([packets[0], packets[1]]);
        doesNotThrow(() => {
            // same order number on another stripe, then with another packet count
            h.asm.push({ ...packets[2], ssrc: BASE + 1 }, 0);
            h.asm.push({ ...packets[2], extension: extension(4, 0) }, 0);
        });
        strictEqual(h.asm.stats.malformed, 2);
        strictEqual(h.pictures.length, 0);

        h.push([packets[2]]);
        deepStrictEqual(h.pictures[0].data, annexB(idr));
    });

    it('never emits a picture whose fragments do not form whole units', () => {
        const idr = nal(IDR, 90);
        const frags = fragments(idr, 20, 3);
        const broken = [
            [frags[1], frags[2]],                         // no start
            [frags[0], frags[1]],                         // no end
            [frags[0], frags[0], frags[2]],               // start inside a unit
            [frags[0], single(nal(TRAIL, 4), 20), frags[2]],  // unit inside a unit
            [frags[0], fragments(nal(TRAIL, 90), 20, 3)[1], frags[2]],  // type changes
        ];
        for (const payloads of broken) {
            const h = harness();
            doesNotThrow(() => h.push(picture({}, payloads), 0));
            strictEqual(h.pictures.length, 0);
            strictEqual(h.asm.stats.malformed, 1);

            // It blocks emission like a missing picture
            h.push(trailPicture(21, { stripe: 1 }), 10);
            h.asm.tick(300);
            strictEqual(h.pictures.length, 0);
        }
    });

    it('stalls behind a broken picture once emission has started', () => {
        const h = harness();
        const frags = fragments(nal(TRAIL, 90), 21, 3);
        h.push(keyPicture(20), 0);
        h.push(picture({ stripe: 1 }, [frags[1], frags[2]]), 0);
        h.push(trailPicture(22, { stripe: 2 }), 10);
        h.asm.tick(211);
        deepStrictEqual(h.stalls, [{ expectedDon: 21, buffered: 2 }]);
        strictEqual(h.pictures.length, 1);
    });

    it('counts every packet', () => {
        const h = harness();
        h.push(keyPicture(1));
        pushRaw(h, new Uint8Array(0));
        h.push([{ ...keyPicture(2)[0], ssrc: 1 }]);
        deepStrictEqual(h.asm.stats, {
            packets: 3, ignored: 1, malformed: 1, duplicates: 0, pictures: 1, discarded: 0,
        });
    });
});

// --- H.264, as an Intel server sends it (Section 14.10.1) ---

const PT_H264 = 123;
const H264_SLICE = 1, H264_IDR = 5;

// Fake H.264 NAL unit: a one-byte header (NRI 1), then `size` filler bytes
function nal264(type, size, seed = 0) {
    const out = new Uint8Array(1 + size);
    out[0] = 0x20 | type;
    for (let i = 0; i < size; i++) out[1 + i] = (type * 29 + seed * 13 + i * 5 + 3) & 0xff;
    return out;
}

// FU-B on every piece: indicator, header, DON, data
function fragments264(unit, don, n) {
    const body = unit.subarray(1);
    const step = Math.ceil(body.length / n);
    const out = [];
    for (let i = 0; i < n; i++) {
        const flags = (i === 0 ? 0x80 : 0) | (i === n - 1 ? 0x40 : 0);
        out.push(concat(
            [(unit[0] & 0xe0) | 29, flags | (unit[0] & 0x1f)],
            u16(don),
            body.subarray(i * step, (i + 1) * step)));
    }
    return out;
}

function box(type, ...content) {
    const body = concat(...content);
    const size = 8 + body.length;
    return concat([size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff],
                  Array.from(type, c => c.charCodeAt(0)), body);
}

const SPS264 = Uint8Array.of(0x27, 0x64, 0x00, 0x34, 0xac, 0x13, 0x16, 0x50);
const PPS264 = Uint8Array.of(0x28, 0xee, 0x1f, 0x2c);

// The parameter packet: four bytes, then an 'avc1' sample entry
function parameterPacket(sps = SPS264, pps = PPS264) {
    const avcC = box('avcC',
        [1, sps[1], sps[2], sps[3], 0xff, 0xe1], u16(sps.length), sps,
        [1], u16(pps.length), pps);
    return concat([0x92, 0xe6, 0xc0, 0xa3],
                  box('avc1', new Uint8Array(78), avcC, box('pasp', [0, 0, 0, 1, 0, 0, 0, 1])));
}

function picture264(where, payloads) {
    return picture(where, payloads).map(p => ({ ...p, payloadType: PT_H264 }));
}

describe('VideoAssembler H.264', () => {
    it('joins the parameter packet and a fragmented IDR slice', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 3000);
        const packets = picture264({ seq: 23663, frame: 27001 }, [
            parameterPacket(),
            ...fragments264(idr, 0, 4),
        ]);
        strictEqual(packets.length, 5);

        h.push(packets.slice(0, 4));
        strictEqual(h.pictures.length, 0, 'not complete before the last packet');
        h.push(packets.slice(4));

        deepStrictEqual(h.pictures, [{
            don: 0, stripe: 0, frame: 27001, key: true, format: 'h264',
            data: annexB(SPS264, PPS264, idr),
        }]);
        strictEqual(h.asm.stats.malformed, 0);
    });

    it('rebuilds the NAL header from the indicator and the fragment header', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 50);
        idr[0] = 0x60 | H264_IDR;       // NRI 3
        h.push(picture264({}, fragments264(idr, 7, 3)));
        deepStrictEqual(h.pictures[0].data, annexB(idr));
        strictEqual(h.pictures[0].key, true);
    });

    it('accepts a unit that starts and ends in one piece', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 40);
        h.push(picture264({}, fragments264(idr, 3, 1)));
        deepStrictEqual(h.pictures[0].data, annexB(idr));
    });

    it('reports a picture without an IDR slice as not key', () => {
        const h = harness();
        h.push(picture264({ seq: 0 }, fragments264(nal264(H264_IDR, 60), 10, 2)));
        const slice = nal264(H264_SLICE, 60);
        h.push(picture264({ seq: 10, stripe: 1 }, fragments264(slice, 11, 2)));
        strictEqual(h.pictures[1].key, false);
        strictEqual(h.pictures[1].format, 'h264');
        deepStrictEqual(h.pictures[1].data, annexB(slice));
    });

    it('starts four stripes, each with its own parameter packet', () => {
        const h = harness();
        const units = [nal264(H264_IDR, 900), nal264(H264_SLICE, 700, 1),
                       nal264(H264_SLICE, 500, 2), nal264(H264_SLICE, 300, 3)];
        const packets = units.flatMap((unit, stripe) => picture264(
            { stripe, seq: 1000 * (stripe + 1), frame: 500 },
            [parameterPacket(), ...fragments264(unit, stripe, 3)]));
        // the lower stripes first: nothing may be emitted before the key picture
        h.push(packets.slice(4));
        strictEqual(h.pictures.length, 0);
        h.push(packets.slice(0, 4));

        deepStrictEqual(h.pictures.map(p => [p.don, p.stripe, p.key]),
                        [[0, 0, true], [1, 1, false], [2, 2, false], [3, 3, false]]);
        units.forEach((unit, i) => {
            deepStrictEqual(h.pictures[i].data, annexB(SPS264, PPS264, unit));
        });
    });

    it('takes the parameter packet when it arrives after the slice', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 400);
        const packets = picture264({ seq: 65534, frame: 8 }, [
            parameterPacket(), ...fragments264(idr, 65535, 3)]);
        h.push([packets[2], packets[3], packets[1]]);
        strictEqual(h.pictures.length, 0);
        h.push([packets[0]]);
        deepStrictEqual(h.pictures[0].data, annexB(SPS264, PPS264, idr));
        strictEqual(h.pictures[0].don & 0xffff, 65535);
    });

    it('does not give a parameter packet to a picture of another frame', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 100);
        const stray = picture264({ seq: 50, frame: 1 }, [parameterPacket(), new Uint8Array(4)])[0];
        h.push([stray]);
        h.push(picture264({ seq: 60, frame: 2 }, fragments264(idr, 0, 2)));
        deepStrictEqual(h.pictures[0].data, annexB(idr));

        // and it is forgotten: a later picture of the same frame number is not held up
        const slice = nal264(H264_SLICE, 100);
        h.push(picture264({ seq: 70, frame: 1 }, fragments264(slice, 1, 2)));
        deepStrictEqual(h.pictures[1].data, annexB(slice));
    });

    it('ignores a duplicated parameter packet', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 100);
        const packets = picture264({ seq: 5, frame: 3 }, [
            parameterPacket(), ...fragments264(idr, 0, 2)]);
        h.push([packets[0], packets[1], packets[0]]);
        strictEqual(h.asm.stats.duplicates, 1);
        h.push([packets[2]]);
        deepStrictEqual(h.pictures[0].data, annexB(SPS264, PPS264, idr));
    });

    it('drops a parameter packet whose boxes do not hold together', () => {
        const h = harness();
        const good = parameterPacket();
        const cut = good.subarray(0, good.length - 30);
        const noRecord = concat([0x92, 0xe6, 0xc0, 0xa3], box('avc1', new Uint8Array(78)));
        for (const payload of [cut, noRecord]) {
            h.push(picture264({ seq: 0 }, [payload, new Uint8Array(4)]).slice(0, 1));
        }
        strictEqual(h.asm.stats.malformed, 2);
    });

    it('drops H.264 payload forms it does not know', () => {
        const h = harness();
        for (const type of [0, 24, 25, 28, 30, 31]) {
            h.push(picture264({}, [Uint8Array.of(0x20 | type, 0x85, 0, 0, 1, 2, 3)]));
        }
        strictEqual(h.asm.stats.malformed, 6);
        strictEqual(h.pictures.length, 0);
    });

    it('drops a packet whose payload type differs from its picture', () => {
        const h = harness();
        const idr = nal264(H264_IDR, 80);
        const packets = picture264({ seq: 4 }, fragments264(idr, 6, 3));
        h.push([packets[0], packets[1]]);
        h.asm.push({ ...packets[2], payloadType: 100, payload: fragments(nal(IDR, 80), 6, 3)[2] }, 0);
        strictEqual(h.asm.stats.malformed, 1);
        h.push([packets[2]]);
        deepStrictEqual(h.pictures[0].data, annexB(idr));
    });

    it('stalls behind a missing picture as it does for HEVC', () => {
        const h = harness({ stallMs: 100 });
        h.push(picture264({ seq: 0 }, fragments264(nal264(H264_IDR, 50), 0, 2)), 0);
        h.push(picture264({ seq: 20, stripe: 2 }, fragments264(nal264(H264_SLICE, 50), 2, 2)), 10);
        h.asm.tick(200);
        deepStrictEqual(h.stalls, [{ expectedDon: 1, buffered: 1 }]);
    });
});
