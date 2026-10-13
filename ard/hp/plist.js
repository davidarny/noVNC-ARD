/*
 * noVNC-ARD: Binary property list ("bplist00") subset codec
 *
 * Supports one shape: a top-level dictionary with string keys whose values
 * are data (Uint8Array), strings, or non-negative integers.
 *
 * Decoding does not read a value of any other kind (booleans, reals, dates,
 * arrays, nested dictionaries, integers a Number cannot hold): its key is
 * returned with the value undefined. A dictionary that has gained such a key
 * can then still be read for the keys that are understood. A list that is
 * malformed is rejected, as is encoding a value of another kind.
 *
 * Layout:
 *   "bplist00"
 *   objects        one marker byte each (high nibble: type, low nibble: size or count)
 *   offset table   one big-endian file offset per object
 *   trailer        32 bytes: 6 unused, offset int size, object ref size,
 *                  u64 object count, u64 top object, u64 offset table offset
 *
 * A low nibble of 0xF means the real size follows as an integer object.
 */

const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30];    // "bplist00"
const HEADER_LEN = 8;
const TRAILER_LEN = 32;

const TYPE_INT = 0x10;
const TYPE_DATA = 0x40;
const TYPE_ASCII = 0x50;
const TYPE_UTF16 = 0x60;
const TYPE_DICT = 0xd0;

function fail(why) {
    throw new Error(`plist: ${why}`);
}

/**
 * Decode a binary property list.
 * @param {Uint8Array} bytes
 * @returns {Object<string, Uint8Array|string|number|undefined>}
 */
export function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('plist: input must be a Uint8Array');
    if (bytes.length < HEADER_LEN + TRAILER_LEN) fail('too short');
    for (let i = 0; i < HEADER_LEN; i++) {
        if (bytes[i] !== MAGIC[i]) fail('bad magic');
    }

    // Big-endian unsigned integer of `size` bytes at `pos`, bounded by `limit`.
    function uint(pos, size, limit) {
        if (pos + size > limit) fail('truncated');
        let value = 0;
        for (let i = 0; i < size; i++) value = value * 256 + bytes[pos + i];
        if (value > Number.MAX_SAFE_INTEGER) fail('integer out of range');
        return value;
    }

    // Trailer
    const trailer = bytes.length - TRAILER_LEN;
    const offsetSize = bytes[trailer + 6];
    const refSize = bytes[trailer + 7];
    const count = uint(trailer + 8, 8, bytes.length);
    const top = uint(trailer + 16, 8, bytes.length);
    const tableAt = uint(trailer + 24, 8, bytes.length);

    if (offsetSize < 1 || offsetSize > 4) fail('bad offset int size');
    if (refSize < 1 || refSize > 2) fail('bad object ref size');
    if (count < 1) fail('no objects');
    if (top >= count) fail('top object out of range');
    // Header, objects, offset table and trailer must account for every byte.
    if (tableAt <= HEADER_LEN) fail('bad offset table offset');
    if (tableAt + count * offsetSize !== trailer) fail('bad offset table');

    // Objects live in [HEADER_LEN, tableAt); nothing may read past tableAt.
    function objectAt(ref) {
        if (ref >= count) fail('object ref out of range');
        const pos = uint(tableAt + ref * offsetSize, offsetSize, trailer);
        if (pos < HEADER_LEN || pos >= tableAt) fail('object offset out of range');
        return pos;
    }

    // Size or count in a marker's low nibble. Returns [size, position after it].
    function sized(pos) {
        const nibble = bytes[pos] & 0x0f;
        if (nibble !== 0x0f) return [nibble, pos + 1];
        if (pos + 1 >= tableAt) fail('truncated');
        const marker = bytes[pos + 1];
        if ((marker & 0xf0) !== TYPE_INT || (marker & 0x0f) > 3) fail('bad length marker');
        const width = 1 << (marker & 0x0f);
        return [uint(pos + 2, width, tableAt), pos + 2 + width];
    }

    function readString(ref) {
        const pos = objectAt(ref);
        const type = bytes[pos] & 0xf0;
        if (type !== TYPE_ASCII && type !== TYPE_UTF16) return undefined;
        const [units, start] = sized(pos);
        const width = type === TYPE_ASCII ? 1 : 2;
        if (units * width > tableAt - start) fail('truncated string');
        let out = '';
        for (let i = 0; i < units; i++) {
            const code = uint(start + i * width, width, tableAt);
            if (width === 1 && code > 0x7f) fail('non-ASCII byte in ASCII string');
            out += String.fromCharCode(code);
        }
        return out;
    }

    function readValue(ref) {
        const pos = objectAt(ref);
        const marker = bytes[pos];
        switch (marker & 0xf0) {
            case TYPE_INT: {
                const width = 1 << (marker & 0x0f);
                if (pos + 1 + width > tableAt) fail('truncated');
                // Not read: wider than 8 bytes, negative (8-byte integers
                // are signed, narrower ones unsigned), or past what a
                // Number holds exactly.
                if (width > 8 || (width === 8 && (bytes[pos + 1] & 0x80))) return undefined;
                let value = 0;
                for (let i = 0; i < width; i++) value = value * 256 + bytes[pos + 1 + i];
                return value > Number.MAX_SAFE_INTEGER ? undefined : value;
            }
            case TYPE_DATA: {
                const [length, start] = sized(pos);
                if (length > tableAt - start) fail('truncated data');
                return new Uint8Array(bytes.subarray(start, start + length));
            }
            case TYPE_ASCII:
            case TYPE_UTF16:
                return readString(ref);
            default:
                return undefined;       // a kind of value this codec does not read
        }
    }

    // Top-level dictionary: `pairs` key refs followed by `pairs` value refs.
    const dictAt = objectAt(top);
    if ((bytes[dictAt] & 0xf0) !== TYPE_DICT) fail('top object is not a dictionary');
    const [pairs, refsAt] = sized(dictAt);
    if (pairs * 2 * refSize > tableAt - refsAt) fail('truncated dictionary');

    const entries = [];
    const seen = new Set();
    for (let i = 0; i < pairs; i++) {
        const key = readString(uint(refsAt + i * refSize, refSize, tableAt));
        if (key === undefined) fail('dictionary key is not a string');
        if (seen.has(key)) fail('repeated dictionary key');
        seen.add(key);
        entries.push([key, readValue(uint(refsAt + (pairs + i) * refSize, refSize, tableAt))]);
    }
    // fromEntries defines own properties, so a "__proto__" key stays a key.
    return Object.fromEntries(entries);
}

// Big-endian bytes of `value` in `size` bytes.
function uintBytes(value, size) {
    const out = new Array(size);
    for (let i = size - 1; i >= 0; i--) {
        out[i] = value % 256;
        value = Math.floor(value / 256);
    }
    return out;
}

// Smallest of 1, 2, 4 or 8 bytes that holds `value`.
function uintSize(value) {
    if (value < 0x100) return 1;
    if (value < 0x10000) return 2;
    if (value < 0x100000000) return 4;
    return 8;
}

// Integer object: marker 0x10 | log2(size), then the value.
function intObject(value) {
    const size = uintSize(value);
    return [TYPE_INT | Math.log2(size), ...uintBytes(value, size)];
}

// Marker byte, with the size inline when it fits in the low nibble.
function marker(type, size) {
    return size < 0x0f ? [type | size] : [type | 0x0f, ...intObject(size)];
}

function stringObject(s) {
    let ascii = true;
    for (let i = 0; i < s.length && ascii; i++) ascii = s.charCodeAt(i) < 0x80;
    const out = marker(ascii ? TYPE_ASCII : TYPE_UTF16, s.length);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (!ascii) out.push(code >> 8);
        out.push(code & 0xff);
    }
    return out;
}

function valueObject(key, value) {
    if (typeof value === 'string') return stringObject(value);
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`plist: "${key}" must be a non-negative safe integer`);
        }
        return intObject(value);
    }
    if (value instanceof Uint8Array) return [...marker(TYPE_DATA, value.length), ...value];
    throw new TypeError(`plist: "${key}" has an unsupported type`);
}

/**
 * Encode a dictionary as a binary property list.
 *
 * Keys are written in the object's own enumeration order and every value gets
 * its own object, which is what Python's plistlib writes (sort_keys=False)
 * when no two values are equal. Apple's and Python's decoders both read it.
 *
 * @param {Object<string, Uint8Array|string|number>} dict
 * @returns {Uint8Array}
 */
export function encode(dict) {
    if (dict === null || typeof dict !== 'object' || Array.isArray(dict) || ArrayBuffer.isView(dict)) {
        throw new TypeError('plist: input must be a plain object');
    }

    const keys = Object.keys(dict);
    const count = 1 + keys.length * 2;
    if (count > 0xffff) throw new RangeError('plist: too many keys');
    const refSize = count < 0x100 ? 1 : 2;

    // Object 0 is the dictionary, 1..n the keys, n+1..2n the values.
    const dictObject = marker(TYPE_DICT, keys.length);
    for (let ref = 1; ref < count; ref++) dictObject.push(...uintBytes(ref, refSize));
    const objects = [dictObject];
    for (const key of keys) objects.push(stringObject(key));
    for (const key of keys) objects.push(valueObject(key, dict[key]));

    const offsets = [];
    let tableAt = HEADER_LEN;
    for (const object of objects) {
        offsets.push(tableAt);
        tableAt += object.length;
    }
    const offsetSize = uintSize(tableAt);
    if (offsetSize > 4) throw new RangeError('plist: too large');

    const out = new Uint8Array(tableAt + count * offsetSize + TRAILER_LEN);
    out.set(MAGIC, 0);
    objects.forEach((object, i) => out.set(object, offsets[i]));
    offsets.forEach((offset, i) => out.set(uintBytes(offset, offsetSize), tableAt + i * offsetSize));

    const trailer = out.length - TRAILER_LEN;
    out[trailer + 6] = offsetSize;
    out[trailer + 7] = refSize;
    out.set(uintBytes(count, 8), trailer + 8);
    // Top object is 0, already zero-filled.
    out.set(uintBytes(tableAt, 8), trailer + 24);
    return out;
}
