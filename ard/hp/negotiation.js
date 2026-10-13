/*
 * High Performance mode — negotiation messages on the TCP connection.
 *
 * ARD protocol spec, Sections 14.5 to 14.8:
 *   server → client  rectangle, encoding 1110   "Message 1"
 *   client → server  message 0x1c               keys and offers
 *   server → client  rectangle, encoding 1010   the answer
 */

import * as protobuf from './protobuf.js';
import * as plist from './plist.js';
import { deflate, inflate } from './zlib.js';
import {
    DEFAULT_ENDPOINT, MODE_AUDIO, MODE_VIDEO,
    endpointFields, audioBlobFields, videoBlobFields,
} from './offer-template.js';

export const MSG_MEDIA_STREAM_NEGOTIATION = 0x1c;
export const OFFER_VERSION = 3;
export const OFFER_FLAGS = 0x0000000d;
export const KEY_BLOCK_LENGTH = 92;

const KEY_BLOB = 'avcMediaStreamNegotiatorMediaBlob';
const KEY_ENDPOINT = 'avcMediaStreamOptionRemoteEndpointInfo';
const KEY_MODE = 'avcMediaStreamNegotiatorMode';
const KEY_CALL_ID = 'avcMediaStreamOptionCallID';

const SECONDS_1900_TO_1970 = 2208988800n;

function u16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

// Nested [field, value] lists → protocol buffer bytes.
function encodeMessage(pairs) {
    return protobuf.encode(pairs.map(([field, value]) => ({
        field,
        value: Array.isArray(value) ? encodeMessage(value) : value,
    })));
}

// The time as the offers carry it: NTP seconds in the upper 32 bits.
export function ntpFromUnixMs(ms) {
    const seconds = BigInt(Math.floor(ms / 1000)) + SECONDS_1900_TO_1970;
    const fraction = BigInt(Math.floor((ms % 1000) / 1000 * 0x100000000));
    return (seconds << 32n) | fraction;
}

function randomSsrc() {
    const v = new Uint32Array(1);
    do {
        crypto.getRandomValues(v);
    } while (v[0] === 0);
    return v[0];
}

function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
}

function uuidString(bytes) {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return (hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
            hex.slice(16, 20) + '-' + hex.slice(20)).toUpperCase();
}

function randomUuid() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return b;
}

/*
 * Everything the client invents for one session. A key block is
 *   [0..32)  master key,  client → server     [32..46) its salt
 *   [46..78) master key,  server → client     [78..92) its salt
 */
export function generateSecrets() {
    return {
        sessionId: randomUuid(),
        audioKeys: randomBytes(KEY_BLOCK_LENGTH),
        videoKeys: randomBytes(KEY_BLOCK_LENGTH),
        audioSsrc: randomSsrc(),
        videoSsrc: randomSsrc(),
        callIds: [uuidString(randomUuid()), uuidString(randomUuid())],
    };
}

export function splitKeyBlock(block) {
    if (block.length !== KEY_BLOCK_LENGTH) {
        throw new Error('key block must be ' + KEY_BLOCK_LENGTH + ' bytes');
    }
    return {
        toServer: { key: block.subarray(0, 32), salt: block.subarray(32, 46) },
        fromServer: { key: block.subarray(46, 78), salt: block.subarray(78, 92) },
    };
}

/*
 * Message 1. `payload` is the rectangle's payload, starting with its
 * 16-bit length.
 */
export function parseMessage1(payload) {
    if (payload.length < 2) throw new Error('message 1: truncated');
    const length = u16(payload, 0);
    if (payload.length < 2 + length || length < 16) {
        throw new Error('message 1: truncated');
    }
    const body = payload.subarray(2, 2 + length);
    const lengths = [u16(body, 10), u16(body, 12), u16(body, 14)];
    const strings = [];
    let offset = 16;
    for (const n of lengths) {
        if (offset + n > body.length) throw new Error('message 1: bad string length');
        let end = offset + n;
        while (end > offset && body[end - 1] === 0) end--;
        strings.push(String.fromCharCode(...body.subarray(offset, end)));
        offset += n;
    }
    return { model: strings[0], strings };
}

async function buildStreamOffer(mode, blobFields, callId, endpoint) {
    return plist.encode({
        [KEY_ENDPOINT]: encodeMessage(endpointFields(endpoint)),
        [KEY_MODE]: mode,
        [KEY_BLOB]: await deflate(encodeMessage(blobFields)),
        [KEY_CALL_ID]: callId,
    });
}

/*
 * The complete 0x1c message: header, session id, then for audio and for
 * video a key block followed by that stream's offer. `codecs` limits the
 * video codecs the offer lists ('h264', 'hevc'); the default is both.
 */
export async function buildOffer(secrets, { ntpTime, endpoint = DEFAULT_ENDPOINT, codecs } = {}) {
    if (ntpTime === undefined) ntpTime = ntpFromUnixMs(Date.now());
    if (secrets.audioKeys.length !== KEY_BLOCK_LENGTH ||
        secrets.videoKeys.length !== KEY_BLOCK_LENGTH ||
        secrets.sessionId.length !== 16) {
        throw new Error('offer: bad secrets');
    }

    const audio = await buildStreamOffer(
        MODE_AUDIO, audioBlobFields({ ssrc: secrets.audioSsrc, ntpTime }),
        secrets.callIds[0], endpoint);
    const video = await buildStreamOffer(
        MODE_VIDEO, videoBlobFields({ ssrc: secrets.videoSsrc, ntpTime, codecs }),
        secrets.callIds[1], endpoint);

    const total = 36 + KEY_BLOCK_LENGTH + audio.length + KEY_BLOCK_LENGTH + video.length;
    if (total - 4 > 0xffff || audio.length > 0xffff || video.length > 0xffff) {
        throw new Error('offer: too large');
    }

    const msg = new Uint8Array(total);
    const view = new DataView(msg.buffer);
    msg[0] = MSG_MEDIA_STREAM_NEGOTIATION;
    view.setUint16(2, total - 4);
    view.setUint16(4, OFFER_VERSION);
    view.setUint32(6, OFFER_FLAGS);
    view.setUint16(10, audio.length);
    view.setUint16(12, video.length);
    // Three further stream sizes stay 0.
    msg.set(secrets.sessionId, 20);

    let offset = 36;
    for (const [keys, offer] of [[secrets.audioKeys, audio], [secrets.videoKeys, video]]) {
        msg.set(keys, offset);
        offset += KEY_BLOCK_LENGTH;
        msg.set(offer, offset);
        offset += offer.length;
    }
    return msg;
}

async function readBlob(bytes, what) {
    const dict = plist.decode(bytes);
    const blob = dict[KEY_BLOB];
    if (!(blob instanceof Uint8Array)) throw new Error('answer: ' + what + ' has no media blob');
    return protobuf.decode(await inflate(blob));
}

function requireNumber(value, what) {
    if (typeof value !== 'number') throw new Error('answer: missing ' + what);
    return value;
}

/*
 * The answer. `payload` is the rectangle's payload, starting with its
 * 16-bit length. Resolves to the server's SSRCs and the picture size.
 */
export async function parseAnswer(payload) {
    if (payload.length < 2) throw new Error('answer: truncated');
    const length = u16(payload, 0);
    if (payload.length < 2 + length || length < 18) throw new Error('answer: truncated');
    const body = payload.subarray(2, 2 + length);

    const audioSize = u16(body, 8);
    const videoSize = u16(body, 10);
    if (audioSize === 0 || videoSize === 0 || 18 + audioSize + videoSize > body.length) {
        throw new Error('answer: bad stream sizes');
    }

    const audioBlob = await readBlob(body.subarray(18, 18 + audioSize), 'audio');
    const videoBlob = await readBlob(
        body.subarray(18 + audioSize, 18 + audioSize + videoSize), 'video');

    const audioParams = protobuf.get(audioBlob, 3);
    const videoParams = protobuf.get(videoBlob, 5);
    if (!(audioParams instanceof Uint8Array)) throw new Error('answer: no audio parameters');
    if (!(videoParams instanceof Uint8Array)) throw new Error('answer: no video parameters');

    const audio = protobuf.decode(audioParams);
    const video = protobuf.decode(videoParams);

    return {
        version: u16(body, 0),
        audio: {
            ssrc: requireNumber(protobuf.get(audio, 1), 'audio SSRC') >>> 0,
        },
        video: {
            ssrc: requireNumber(protobuf.get(video, 1), 'video SSRC') >>> 0,
            width: requireNumber(protobuf.get(video, 4), 'width'),
            height: requireNumber(protobuf.get(video, 5), 'height'),
            stripes: requireNumber(protobuf.get(video, 6), 'stripe count'),
        },
    };
}
