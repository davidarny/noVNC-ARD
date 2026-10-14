/*
 * noVNC-ARD: High Performance video, RTP packets → HEVC pictures
 *
 * The server sends one HEVC bitstream over several RTP streams, one for each
 * stripe of the screen (SSRC = base + stripe). Payloads follow RFC 7798 with
 * one difference: a 16-bit decoding order number (DON) follows the payload
 * header of every packet. There is one DON for each picture, counted across
 * all streams, and the header extension gives the picture's packet count.
 *
 * The assembler collects the packets of each picture in any arrival order,
 * rebuilds its NAL units and emits the pictures strictly in DON order,
 * starting at the first key picture. Nothing is retransmitted, so a picture
 * that stays missing ends the stream: onStall fires once and emission stops.
 *
 * Payloads are kept by reference until their picture is emitted or dropped.
 */

import { seqDelta, extendSeq } from './seq.js';

const MAX_BUFFERED = 512;       // pictures collecting or waiting; more means the stream is lost

const TYPE_AGGREGATION = 48;
const TYPE_FRAGMENT = 49;

function nalType(byte0) {
    return (byte0 >> 1) & 0x3f;
}

// Split one RTP payload. Returns null when it is malformed, otherwise its DON
// and either `units` (whole NAL units, each a list of byte chunks) or
// `fragment` (the payload of one piece of a NAL unit).
function parsePayload(p) {
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
        return { don: (p[3] << 8) | p[4], fragment: p };
    }

    return null;
}

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
function assemble(parts) {
    const units = [];
    let open = null;            // fragmented unit being rebuilt: { type, chunks }

    for (const part of parts) {
        const p = part.fragment;
        if (!p) {
            if (open) return null;
            for (const unit of part.units) units.push(unit);
            continue;
        }

        const type = p[2] & 0x3f;
        if (p[2] & 0x80) {
            // Start: the unit's own header is the payload header with the type replaced
            if (open) return null;
            open = { type, chunks: [Uint8Array.of((p[0] & 0x81) | (type << 1), p[1])] };
        } else if (!open || open.type !== type) {
            return null;
        }
        open.chunks.push(p.subarray(5));
        if (p[2] & 0x40) {
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
        const type = nalType(chunks[0][0]);
        if (type >= 16 && type <= 21) key = true;       // IRAP
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
    // onPicture({ don, stripe, frame, key, data })
    //   don:   DON unwrapped to a growing integer; don & 0xffff is the wire value
    //   data:  the picture's NAL units as Annex B (00 00 00 01 start codes)
    // onStall({ expectedDon, buffered })
    //   expectedDon: the picture that never completed, null if no key picture came
    constructor({ baseSsrc, stripes, onPicture, onStall, stallMs = 200 }) {
        this._baseSsrc = baseSsrc;
        this._stripes = stripes;
        this._onPicture = onPicture;
        this._onStall = onStall;
        this._stallMs = stallMs;

        this._pictures = new Map();     // unwrapped DON → picture collecting or waiting
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

    // A snapshot of where the assembler is, for diagnosing a freeze.
    get diag() {
        return {
            buffered: this._pictures.size, next: this._next, first: this._first,
            stalled: this._stalled, ignored: this.stats.ignored, malformed: this.stats.malformed,
            duplicates: this.stats.duplicates, emitted: this.stats.pictures,
        };
    }

    // One decrypted RTP packet. The marker bit is not needed: the extension
    // carries the picture's packet count.
    push({ ssrc, seq, extension, payload }, nowMs) {
        this.stats.packets++;
        if (this._stalled) {
            this.stats.ignored++;
            return;
        }
        this._collect(ssrc, seq, extension, payload, nowMs);
        this._checkStall(nowMs);
    }

    tick(nowMs) {
        this._checkStall(nowMs);
    }

    _collect(ssrc, seq, extension, payload, nowMs) {
        const stats = this.stats;

        const stripe = ssrc - this._baseSsrc;
        if (!Number.isInteger(stripe) || stripe < 0 || stripe >= this._stripes ||
            !(extension instanceof Uint8Array) || extension.length !== 8) {
            stats.ignored++;
            return;
        }
        const count = (extension[4] << 8) | extension[5];
        const frame = (extension[6] << 8) | extension[7];

        const part = parsePayload(payload);
        if (!part || count === 0 || !Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
            stats.malformed++;
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
            pic = { don, stripe, frame, count, parts: new Map(), data: null, key: false, doneAt: 0 };
            this._pictures.set(don, pic);
        } else if (pic.stripe !== stripe || pic.count !== count) {
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

        const built = assemble(inSequenceOrder(pic.parts));
        if (!built) {
            // Stays incomplete; emission stops at it like at a missing picture
            stats.malformed++;
            return;
        }
        pic.data = built.data;
        pic.key = built.key;
        pic.doneAt = nowMs;

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
                don: pic.don, stripe: pic.stripe, frame: pic.frame, key: pic.key, data: pic.data,
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
        this._onStall({ expectedDon: this._next, buffered });
    }
}
