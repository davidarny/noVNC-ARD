/*
 * noVNC-ARD: High Performance video, RTP packets → HEVC or H.264 pictures
 *
 * The server sends one bitstream over several RTP streams, one for each
 * stripe of the screen (SSRC = base + stripe). An Apple silicon server sends
 * HEVC, an Intel server H.264; the RTP payload type says which.
 *
 * HEVC payloads follow RFC 7798 with one difference: a 16-bit decoding order
 * number (DON) follows the payload header of every packet. H.264 pictures
 * come as fragments in the FU-B form of RFC 6184, which has the DON too, and
 * the parameter sets in a packet of their own that has none. There is one
 * DON for each picture, counted across all streams, and the header extension
 * gives the picture's packet count.
 *
 * The assembler collects the packets of each picture in any arrival order,
 * rebuilds its NAL units and emits the pictures strictly in DON order,
 * starting at the first key picture. Nothing is retransmitted, so a picture
 * that stays missing ends the stream: onStall fires once and emission stops.
 *
 * Payloads are kept by reference until their picture is emitted or dropped.
 */

import { seqDelta, extendSeq } from './seq.js';
import { PAYLOAD_TYPE_H264 } from './offer-template.js';
import { NAL_IDR, isParameterPacket, parseParameterPacket } from './h264.js';

const MAX_BUFFERED = 512;       // pictures collecting or waiting; more means the stream is lost

const TYPE_AGGREGATION = 48;
const TYPE_FRAGMENT = 49;

const H264_TYPE_FRAGMENT = 29;  // FU-B

function nalType(byte0) {
    return (byte0 >> 1) & 0x3f;
}

/*
 * Split one RTP payload. Returns null when it is malformed, otherwise its DON
 * and either `units` (whole NAL units, each a list of byte chunks) or
 * `fragment`, one piece of a NAL unit:
 *   { start, end, type, head, data }
 * where `head` is the unit's own header, present on the starting piece.
 */
function parseHevc(p) {
    if (!(p instanceof Uint8Array) || p.length < 4) return null;
    const type = nalType(p[0]);

    if (type < TYPE_AGGREGATION) {
        // NAL header, DON, rest of the unit
        return { don: (p[2] << 8) | p[3], units: [[p.subarray(0, 2), p.subarray(4)]] };
    }

    if (type === TYPE_AGGREGATION) {
        // payload header, DON, then { size, unit } repeated
        const units = [];
        let o = 4;
        while (o < p.length) {
            if (o + 2 > p.length) return null;
            const size = (p[o] << 8) | p[o + 1];
            o += 2;
            if (size < 2 || o + size > p.length) return null;
            units.push([p.subarray(o, o + size)]);
            o += size;
        }
        if (units.length === 0) return null;
        return { don: (p[2] << 8) | p[3], units };
    }

    if (type === TYPE_FRAGMENT) {
        // payload header, fragment header, DON, fragment data
        if (p.length < 5) return null;
        const unitType = p[2] & 0x3f;
        const start = (p[2] & 0x80) !== 0;
        return {
            don: (p[3] << 8) | p[4],
            fragment: {
                start,
                end: (p[2] & 0x40) !== 0,
                type: unitType,
                // The payload header with the type replaced
                head: start ? Uint8Array.of((p[0] & 0x81) | (unitType << 1), p[1]) : null,
                data: p.subarray(5),
            },
        };
    }

    return null;
}

// The same for H.264. The parameter packet has no DON: `don` is null.
function parseH264(p) {
    if (!(p instanceof Uint8Array) || p.length < 4) return null;
    const type = p[0] & 0x1f;

    if (type === H264_TYPE_FRAGMENT) {
        // FU indicator, FU header, DON, fragment data
        const unitType = p[1] & 0x1f;
        const start = (p[1] & 0x80) !== 0;
        return {
            don: (p[2] << 8) | p[3],
            fragment: {
                start,
                end: (p[1] & 0x40) !== 0,
                type: unitType,
                head: start ? Uint8Array.of((p[0] & 0xe0) | unitType) : null,
                data: p.subarray(4),
            },
        };
    }

    if (isParameterPacket(p)) {
        const sets = parseParameterPacket(p);
        return sets ? { don: null, units: sets.map(unit => [unit]) } : null;
    }

    if (type >= 1 && type <= 23) {
        // A whole NAL unit. No server has been seen to send one; the layout
        // is the HEVC one with a one-byte header: NAL header, DON, the rest.
        return { don: (p[1] << 8) | p[2], units: [[p.subarray(0, 1), p.subarray(3)]] };
    }

    return null;
}

const HEVC = {
    name: 'hevc',
    parse: parseHevc,
    isKey: (byte0) => {                                 // IRAP
        const type = nalType(byte0);
        return type >= 16 && type <= 21;
    },
};

const H264 = {
    name: 'h264',
    parse: parseH264,
    isKey: byte0 => (byte0 & 0x1f) === NAL_IDR,
};

// The parts of one picture, ordered by sequence number. A picture is far
// shorter than half the sequence space, so distances from any one of its
// packets order it correctly across the 65535 → 0 wrap.
function inSequenceOrder(parts) {
    const entries = [];
    let first = null;
    for (const [seq, part] of parts) {
        if (first === null) first = seq;
        entries.push([seqDelta(seq, first), part]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    return entries.map(entry => entry[1]);
}

// Join the ordered parts of a picture into Annex B. Returns null when the
// fragments do not form whole NAL units.
function assemble(parts, format) {
    const units = [];
    let open = null;            // fragmented unit being rebuilt: { type, chunks }

    for (const part of parts) {
        const f = part.fragment;
        if (!f) {
            if (open) return null;
            for (const unit of part.units) units.push(unit);
            continue;
        }

        if (f.start) {
            if (open) return null;
            open = { type: f.type, chunks: [f.head] };
        } else if (!open || open.type !== f.type) {
            return null;
        }
        open.chunks.push(f.data);
        if (f.end) {
            units.push(open.chunks);
            open = null;
        }
    }
    if (open || units.length === 0) return null;

    let size = 0;
    let key = false;
    for (const chunks of units) {
        size += 4;
        for (const chunk of chunks) size += chunk.length;
        if (format.isKey(chunks[0][0])) key = true;
    }

    const data = new Uint8Array(size);
    let o = 0;
    for (const chunks of units) {
        data[o + 3] = 1;                                // 00 00 00 01
        o += 4;
        for (const chunk of chunks) {
            data.set(chunk, o);
            o += chunk.length;
        }
    }
    return { data, key };
}

export class VideoAssembler {
    // onPicture({ don, stripe, frame, key, format, data })
    //   don:    DON unwrapped to a growing integer; don & 0xffff is the wire value
    //   format: 'hevc' or 'h264'
    //   data:   the picture's NAL units as Annex B (00 00 00 01 start codes)
    // onStall({ expectedDon, buffered })
    //   expectedDon: the picture that never completed, null if no key picture came
    constructor({ baseSsrc, stripes, onPicture, onStall, stallMs = 200 }) {
        this._baseSsrc = baseSsrc;
        this._stripes = stripes;
        this._onPicture = onPicture;
        this._onStall = onStall;
        this._stallMs = stallMs;

        this._pictures = new Map();     // unwrapped DON → picture collecting or waiting
        this._parameters = new Map();   // stripe → parameter packet waiting for its picture
        this._ref = null;               // first wire DON seen; unwrap reference until the start
        this._first = null;             // DON of the first key picture
        this._next = null;              // next DON to emit; null until the first key picture
        this._stalled = false;

        this.stats = {
            packets: 0,         // every push
            ignored: 0,         // foreign SSRC, no extension, older than the start, or after a stall
            malformed: 0,       // unusable payload or header, or a picture that does not fit together
            duplicates: 0,      // packet already held or its picture already emitted
            pictures: 0,        // emitted
            discarded: 0,       // dropped for preceding the first key picture
        };
    }

    // One decrypted RTP packet. The marker bit is not needed: the extension
    // carries the picture's packet count.
    push({ ssrc, seq, payloadType, extension, payload }, nowMs) {
        this.stats.packets++;
        if (this._stalled) {
            this.stats.ignored++;
            return;
        }
        const format = payloadType === PAYLOAD_TYPE_H264 ? H264 : HEVC;
        this._collect(ssrc, seq, format, extension, payload, nowMs);
        this._checkStall(nowMs);
    }

    tick(nowMs) {
        this._checkStall(nowMs);
    }

    _collect(ssrc, seq, format, extension, payload, nowMs) {
        const stats = this.stats;

        const stripe = ssrc - this._baseSsrc;
        if (!Number.isInteger(stripe) || stripe < 0 || stripe >= this._stripes ||
            !(extension instanceof Uint8Array) || extension.length !== 8) {
            stats.ignored++;
            return;
        }
        const count = (extension[4] << 8) | extension[5];
        const frame = (extension[6] << 8) | extension[7];

        const part = format.parse(payload);
        if (!part || count === 0 || !Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
            stats.malformed++;
            return;
        }

        if (part.don === null) {
            // Parameter sets: they belong to the picture of this stripe and
            // frame, which is known by its number only once a piece of it
            // has come.
            const held = { stripe, frame, count, format, seq, part };
            for (const pic of this._pictures.values()) {
                if (pic.stripe === stripe && pic.frame === frame && pic.data === null) {
                    this._add(pic, held, nowMs);
                    return;
                }
            }
            this._parameters.set(stripe, held);
            return;
        }

        const don = this._unwrap(part.don);
        if (this._next !== null && don < this._next) {
            // Everything from the start up to _next has been emitted whole
            if (don >= this._first) stats.duplicates++;
            else stats.ignored++;
            return;
        }

        let pic = this._pictures.get(don);
        if (!pic) {
            pic = { don, stripe, frame, count, format, parts: new Map(), data: null, key: false, doneAt: 0 };
            this._pictures.set(don, pic);
            const held = this._parameters.get(stripe);
            if (held && held.frame === frame) {
                this._parameters.delete(stripe);
                this._add(pic, held, nowMs);
            }
        }
        this._add(pic, { stripe, count, format, seq, part }, nowMs);
    }

    // One more packet of a picture; builds and emits it when it is the last.
    _add(pic, { stripe, count, format, seq, part }, nowMs) {
        const stats = this.stats;
        if (pic.stripe !== stripe || pic.count !== count || pic.format !== format) {
            stats.malformed++;
            return;
        }
        if (pic.parts.has(seq)) {
            stats.duplicates++;
            return;
        }
        if (pic.parts.size >= pic.count) {
            stats.malformed++;
            return;
        }
        pic.parts.set(seq, part);
        if (pic.parts.size < pic.count) return;

        const built = assemble(inSequenceOrder(pic.parts), pic.format);
        if (!built) {
            // Stays incomplete; emission stops at it like at a missing picture
            stats.malformed++;
            return;
        }
        pic.data = built.data;
        pic.key = built.key;
        pic.doneAt = nowMs;
        // A parameter packet that found no picture by now never will
        const held = this._parameters.get(pic.stripe);
        if (held && held.frame !== pic.frame) this._parameters.delete(pic.stripe);

        if (this._next === null && pic.key) this._start(pic);
        this._emit();
    }

    // Wire DON → the integer nearest the reference that is congruent to it
    _unwrap(don16) {
        if (this._ref === null) this._ref = don16;
        const ref = this._next === null ? this._ref : this._next;
        return extendSeq(ref, don16);
    }

    // Emission begins at the first complete key picture
    _start(key) {
        const start = key.don;
        // Only when the key picture precedes the first packet seen across a
        // wrap: move up whole cycles so emitted numbers are never negative
        const shift = start < 0 ? Math.ceil(-start / 0x10000) * 0x10000 : 0;

        const kept = new Map();
        for (const pic of this._pictures.values()) {
            if (pic.don < start) {
                this.stats.discarded++;
                continue;
            }
            pic.don += shift;
            kept.set(pic.don, pic);
        }
        this._pictures = kept;
        this._first = this._next = start + shift;
    }

    _emit() {
        if (this._next === null) return;
        for (;;) {
            const pic = this._pictures.get(this._next);
            if (!pic || pic.data === null) return;
            this._pictures.delete(pic.don);
            this._next++;
            this.stats.pictures++;
            this._onPicture({
                don: pic.don, stripe: pic.stripe, frame: pic.frame, key: pic.key,
                format: pic.format.name, data: pic.data,
            });
        }
    }

    _checkStall(nowMs) {
        if (this._stalled) return;

        let stall = this._pictures.size > MAX_BUFFERED;
        if (!stall && this._next !== null) {
            // The expected picture is not complete, so every complete picture
            // held here is a later one waiting for it
            for (const pic of this._pictures.values()) {
                if (pic.data !== null && nowMs - pic.doneAt > this._stallMs) {
                    stall = true;
                    break;
                }
            }
        }
        if (!stall) return;

        this._stalled = true;
        const buffered = this._pictures.size;
        this._pictures.clear();
        this._parameters.clear();
        this._onStall({ expectedDon: this._next, buffered });
    }
}
