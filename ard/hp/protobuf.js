/*
 * noVNC-ARD: Schema-less protocol buffer codec
 *
 * A message is a list of { field, wire, value } entries in wire order.
 *   wire 0 (varint)            value: Number up to Number.MAX_SAFE_INTEGER, BigInt above
 *   wire 1 (fixed64)           value: Uint8Array of the 8 raw bytes
 *   wire 2 (length-delimited)  value: Uint8Array (nested messages are decoded by the caller)
 *   wire 5 (fixed32)           value: Uint8Array of the 4 raw bytes
 * Groups (wire 3 and 4) and the unassigned wire types 6 and 7 are rejected.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const MAX_FIELD = 0x1fffffff;       // field numbers are 29 bits
const MAX_VARINT = 0xffffffffffffffffn;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Read one varint at `pos`. Returns [value, next position].
function readVarint(bytes, pos) {
    let end = pos;
    while (true) {
        if (end >= bytes.length) throw new Error('protobuf: truncated varint');
        if (end - pos === 10) throw new Error('protobuf: varint longer than 10 bytes');
        if (!(bytes[end++] & 0x80)) break;
    }
    const length = end - pos;

    // Seven bytes carry 49 bits, which a Number holds exactly.
    if (length <= 7) {
        let value = 0;
        for (let i = end - 1; i >= pos; i--) value = value * 128 + (bytes[i] & 0x7f);
        return [value, end];
    }

    if (length === 10 && bytes[end - 1] > 1) throw new Error('protobuf: varint overflows 64 bits');
    let big = 0n;
    for (let i = end - 1; i >= pos; i--) big = (big << 7n) | BigInt(bytes[i] & 0x7f);
    return [big <= MAX_SAFE ? Number(big) : big, end];
}

// Copy out `length` bytes at `pos`; always a plain Uint8Array that does not alias the input.
function take(bytes, pos, length, what) {
    if (length > bytes.length - pos) throw new Error(`protobuf: truncated ${what}`);
    return new Uint8Array(bytes.subarray(pos, pos + length));
}

/**
 * Decode one message.
 * @param {Uint8Array} bytes
 * @returns {{field: number, wire: number, value: number|bigint|Uint8Array}[]}
 */
export function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('protobuf: input must be a Uint8Array');

    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
        let tag;
        [tag, pos] = readVarint(bytes, pos);
        if (typeof tag !== 'number' || tag > 0xffffffff) throw new Error('protobuf: tag out of range');
        const field = Math.floor(tag / 8);
        const wire = tag % 8;
        if (field === 0) throw new Error('protobuf: field number 0');

        let value;
        switch (wire) {
            case WIRE_VARINT:
                [value, pos] = readVarint(bytes, pos);
                break;
            case WIRE_FIXED64:
                value = take(bytes, pos, 8, 'fixed64');
                pos += 8;
                break;
            case WIRE_BYTES: {
                let length;
                [length, pos] = readVarint(bytes, pos);
                if (typeof length !== 'number') throw new Error('protobuf: length out of range');
                value = take(bytes, pos, length, 'length-delimited field');
                pos += length;
                break;
            }
            case WIRE_FIXED32:
                value = take(bytes, pos, 4, 'fixed32');
                pos += 4;
                break;
            default:
                throw new Error(`protobuf: unsupported wire type ${wire}`);
        }
        fields.push({ field, wire, value });
    }
    return fields;
}

// Append a varint to `out` (an array of byte values).
function writeVarint(out, value) {
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_VARINT) throw new RangeError('protobuf: varint out of range');
        while (value > 0x7fn) {
            out.push(Number(value & 0x7fn) | 0x80);
            value >>= 7n;
        }
        out.push(Number(value));
        return;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('protobuf: varint must be a non-negative safe integer or a BigInt');
    }
    while (value > 0x7f) {
        out.push((value % 128) | 0x80);
        value = Math.floor(value / 128);
    }
    out.push(value);
}

// Wire type for an entry that does not name one.
function inferWire(value) {
    if (typeof value === 'number' || typeof value === 'bigint') return WIRE_VARINT;
    if (typeof value === 'string' || value instanceof Uint8Array) return WIRE_BYTES;
    throw new TypeError('protobuf: cannot infer a wire type for this value');
}

/**
 * Encode one message.
 * `wire` may be omitted: Number/BigInt → varint, Uint8Array/string → length-delimited.
 * Strings are written as UTF-8.
 * @param {{field: number, wire?: number, value: number|bigint|Uint8Array|string}[]} fields
 * @returns {Uint8Array}
 */
export function encode(fields) {
    // Each part is either an array of header bytes or a payload Uint8Array.
    const parts = [];
    let total = 0;

    for (const { field, wire: givenWire, value } of fields) {
        if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD) {
            throw new RangeError('protobuf: field number out of range');
        }
        const wire = givenWire === undefined ? inferWire(value) : givenWire;
        const head = [];
        writeVarint(head, field * 8 + wire);

        let body = null;
        switch (wire) {
            case WIRE_VARINT:
                if (typeof value !== 'number' && typeof value !== 'bigint') {
                    throw new TypeError('protobuf: varint value must be a Number or BigInt');
                }
                writeVarint(head, value);
                break;
            case WIRE_FIXED64:
            case WIRE_FIXED32: {
                const size = wire === WIRE_FIXED64 ? 8 : 4;
                if (!(value instanceof Uint8Array) || value.length !== size) {
                    throw new TypeError(`protobuf: fixed value must be a Uint8Array of ${size} bytes`);
                }
                body = value;
                break;
            }
            case WIRE_BYTES:
                if (typeof value === 'string') {
                    body = new TextEncoder().encode(value);
                } else if (value instanceof Uint8Array) {
                    body = value;
                } else {
                    throw new TypeError('protobuf: length-delimited value must be a Uint8Array or string');
                }
                writeVarint(head, body.length);
                break;
            default:
                throw new Error(`protobuf: unsupported wire type ${wire}`);
        }

        parts.push(head);
        total += head.length;
        if (body) {
            parts.push(body);
            total += body.length;
        }
    }

    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

/**
 * Value of the first entry with field number `n`, or undefined.
 */
export function get(fields, n) {
    for (const entry of fields) {
        if (entry.field === n) return entry.value;
    }
    return undefined;
}

/**
 * Values of every entry with field number `n`, in order.
 */
export function getAll(fields, n) {
    const values = [];
    for (const entry of fields) {
        if (entry.field === n) values.push(entry.value);
    }
    return values;
}
