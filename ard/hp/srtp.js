/*
 * noVNC-ARD: SRTP and SRTCP with the AES_256_CM_HMAC_SHA1_80 transform
 *
 * RFC 3711 framework, AES-256 counter mode and key derivation of RFC 6188,
 * HMAC-SHA1 truncated to 80 bits, no MKI, key derivation rate 0.
 * Built on WebCrypto so the same file runs in browsers and in Node.
 * No replay protection.
 */

const TAG_LEN = 10;
const RTP_HEADER_LEN = 12;
const RTCP_HEADER_LEN = 8;
const SEQ_MOD = 0x10000;
const SRTCP_E_BIT = 0x80000000;
const SRTCP_INDEX_MAX = 0x7fffffff;

function getSubtle() {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) {
        throw new Error('SRTP needs WebCrypto (browsers provide it in secure contexts only)');
    }
    return subtle;
}

// AES counter mode with a 16-bit block counter (RFC 3711 4.1.1).
async function aesCtr(subtle, key, counter, data) {
    if (data.length === 0) return new Uint8Array(0);
    return new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter, length: 16 }, key, data));
}

// Counter block: (salt XOR SSRC XOR packet index) shifted left 16 bits.
// The index is 48 bits wide, so it is passed as a Number.
function counterBlock(salt, ssrc, index) {
    const block = new Uint8Array(16);
    const dv = new DataView(block.buffer);
    dv.setUint32(4, ssrc);
    dv.setUint16(8, Math.floor(index / 0x100000000));
    dv.setUint32(10, index >>> 0);
    for (let i = 0; i < salt.length; i++) block[i] ^= salt[i];
    return block;
}

// Rollover counter for `seq`, given the highest packet index seen for its
// SSRC (rollover counter * 65536 + sequence number) or undefined if none.
// RFC 3711 3.3.1 and Appendix A.
function estimateRoc(highest, seq) {
    if (highest === undefined) return 0;
    const roc = Math.floor(highest / SEQ_MOD);
    const last = highest % SEQ_MOD;
    if (last < 0x8000) {
        return (seq - last > 0x8000 && roc > 0) ? roc - 1 : roc;
    }
    return (last - 0x8000 > seq) ? roc + 1 : roc;
}

// Where the header extension and payload start in an RTP packet whose
// header, extension and payload occupy bytes 0..end. null if they overrun.
function rtpLayout(packet, end) {
    if (end < RTP_HEADER_LEN) return null;
    const headerLen = RTP_HEADER_LEN + 4 * (packet[0] & 0x0f);
    let payloadOffset = headerLen;
    if (packet[0] & 0x10) {
        if (headerLen + 4 > end) return null;
        payloadOffset += 4 + 4 * ((packet[headerLen + 2] << 8) | packet[headerLen + 3]);
    }
    return payloadOffset > end ? null : { headerLen, payloadOffset };
}

// Constant-time comparison of the first TAG_LEN bytes.
function tagMatches(mac, tag) {
    let diff = 0;
    for (let i = 0; i < TAG_LEN; i++) diff |= mac[i] ^ tag[i];
    return diff === 0;
}

/**
 * Derive the six session keys from a master key and salt (RFC 3711 4.3.1
 * with the AES-256 pseudo-random function of RFC 6188).
 * Returns raw bytes: { rtp: { cipherKey, authKey, salt }, rtcp: { ... } }.
 */
export async function deriveSessionKeys(masterKey, masterSalt) {
    if (!(masterKey instanceof Uint8Array) || masterKey.length !== 32) {
        throw new TypeError('SRTP master key must be a Uint8Array of 32 bytes');
    }
    if (!(masterSalt instanceof Uint8Array) || masterSalt.length !== 14) {
        throw new TypeError('SRTP master salt must be a Uint8Array of 14 bytes');
    }
    const subtle = getSubtle();
    const key = await subtle.importKey('raw', masterKey, 'AES-CTR', false, ['encrypt']);

    // With a key derivation rate of 0 the label lands on byte 7 of the salt.
    const derive = (label, length) => {
        const counter = new Uint8Array(16);
        counter.set(masterSalt);
        counter[7] ^= label;
        return aesCtr(subtle, key, counter, new Uint8Array(length));
    };
    const [rtpCipher, rtpAuth, rtpSalt, rtcpCipher, rtcpAuth, rtcpSalt] = await Promise.all([
        derive(0, 32), derive(1, 20), derive(2, 14),
        derive(3, 32), derive(4, 20), derive(5, 14),
    ]);
    return {
        rtp: { cipherKey: rtpCipher, authKey: rtpAuth, salt: rtpSalt },
        rtcp: { cipherKey: rtcpCipher, authKey: rtcpAuth, salt: rtcpSalt },
    };
}

class SrtpContext {
    constructor(subtle, rtp, rtcp) {
        this._subtle = subtle;
        this._rtp = rtp;                // { cipher, auth, salt }
        this._rtcp = rtcp;
        this._rxIndex = new Map();      // SSRC → highest verified packet index
        this._txIndex = new Map();      // SSRC → highest packet index sent
        this._rtcpIndex = 0;            // last SRTCP index sent
    }

    async _mac(keys, data) {
        return new Uint8Array(await this._subtle.sign('HMAC', keys.auth, data));
    }

    _crypt(keys, ssrc, index, data) {
        return aesCtr(this._subtle, keys.cipher, counterBlock(keys.salt, ssrc, index), data);
    }

    /**
     * Verify and decrypt one SRTP packet. Resolves to null if the tag does
     * not verify or the packet is malformed.
     */
    async unprotectRtp(packet) {
        if (!(packet instanceof Uint8Array)) return null;
        const end = packet.length - TAG_LEN;
        const layout = rtpLayout(packet, end);
        if (!layout) return null;
        const { headerLen, payloadOffset } = layout;

        // Private copy of the authenticated bytes with room for the rollover
        // counter, so the caller may reuse its buffer while this is pending.
        const buf = new Uint8Array(end + 4);
        buf.set(packet.subarray(0, end));
        const tag = new Uint8Array(packet.subarray(end));
        const dv = new DataView(buf.buffer);
        const seq = dv.getUint16(2);
        const ssrc = dv.getUint32(8);

        // Estimated now, not after an await, so overlapping calls each use
        // the state as it was when their packet arrived.
        let roc = estimateRoc(this._rxIndex.get(ssrc), seq);
        dv.setUint32(end, roc);
        if (!tagMatches(await this._mac(this._rtp, buf), tag)) {
            // An earlier packet may have verified meanwhile and moved the
            // counter (a burst spanning a rollover): try once with the new estimate.
            const retry = estimateRoc(this._rxIndex.get(ssrc), seq);
            if (retry === roc) return null;
            roc = retry;
            dv.setUint32(end, roc);
            if (!tagMatches(await this._mac(this._rtp, buf), tag)) return null;
        }

        // Only a verified packet moves the state, and only forwards.
        const index = roc * SEQ_MOD + seq;
        if (!(this._rxIndex.get(ssrc) >= index)) this._rxIndex.set(ssrc, index);

        const payload = await this._crypt(this._rtp, ssrc, index, buf.subarray(payloadOffset, end));
        return {
            ssrc,
            seq,
            timestamp: dv.getUint32(4),
            marker: (buf[1] & 0x80) !== 0,
            payloadType: buf[1] & 0x7f,
            header: buf.slice(0, headerLen),
            extension: buf.slice(headerLen, payloadOffset),
            payload,
        };
    }

    /** Encrypt and tag one plain RTP packet. */
    async protectRtp(packet) {
        const layout = packet instanceof Uint8Array ? rtpLayout(packet, packet.length) : null;
        if (!layout) throw new TypeError('Malformed RTP packet');
        const end = packet.length;

        const out = new Uint8Array(end + TAG_LEN);
        out.set(packet);
        const dv = new DataView(out.buffer);
        const seq = dv.getUint16(2);
        const ssrc = dv.getUint32(8);

        // The sender's own counter: advanced before any await so overlapping calls agree.
        const roc = estimateRoc(this._txIndex.get(ssrc), seq);
        const index = roc * SEQ_MOD + seq;
        if (!(this._txIndex.get(ssrc) >= index)) this._txIndex.set(ssrc, index);

        const body = out.subarray(layout.payloadOffset, end);
        out.set(await this._crypt(this._rtp, ssrc, index, body), layout.payloadOffset);

        // The tag covers the packet followed by the rollover counter; the
        // counter is written where the tag will go, then overwritten.
        dv.setUint32(end, roc);
        const mac = await this._mac(this._rtp, out.subarray(0, end + 4));
        out.set(mac.subarray(0, TAG_LEN), end);
        return out;
    }

    /**
     * Verify and decrypt one SRTCP packet. Resolves to the plain compound
     * RTCP packet, or null if the tag does not verify or the packet is too short.
     */
    async unprotectRtcp(packet) {
        if (!(packet instanceof Uint8Array)) return null;
        const end = packet.length - TAG_LEN - 4;        // start of the E/index word
        if (end < RTCP_HEADER_LEN) return null;

        const buf = new Uint8Array(packet.subarray(0, end + 4));
        const tag = new Uint8Array(packet.subarray(end + 4));
        if (!tagMatches(await this._mac(this._rtcp, buf), tag)) return null;

        const dv = new DataView(buf.buffer);
        const word = dv.getUint32(end);
        const out = buf.slice(0, end);
        if (word >>> 31) {
            const body = out.subarray(RTCP_HEADER_LEN);
            out.set(await this._crypt(this._rtcp, dv.getUint32(4), word & SRTCP_INDEX_MAX, body),
                    RTCP_HEADER_LEN);
        }
        return out;
    }

    /** Encrypt and tag one plain compound RTCP packet. The first index is 1. */
    async protectRtcp(plain) {
        if (!(plain instanceof Uint8Array) || plain.length < RTCP_HEADER_LEN) {
            throw new TypeError('Malformed RTCP packet');
        }
        if (this._rtcpIndex >= SRTCP_INDEX_MAX) throw new Error('SRTCP index exhausted');
        const index = ++this._rtcpIndex;
        const end = plain.length;

        const out = new Uint8Array(end + 4 + TAG_LEN);
        out.set(plain);
        const dv = new DataView(out.buffer);
        dv.setUint32(end, (SRTCP_E_BIT | index) >>> 0);

        const body = out.subarray(RTCP_HEADER_LEN, end);
        out.set(await this._crypt(this._rtcp, dv.getUint32(4), index, body), RTCP_HEADER_LEN);

        const mac = await this._mac(this._rtcp, out.subarray(0, end + 4));
        out.set(mac.subarray(0, TAG_LEN), end + 4);
        return out;
    }
}

/**
 * Create a context for one direction of one stream.
 * masterKey: Uint8Array(32), masterSalt: Uint8Array(14).
 */
export async function createContext(masterKey, masterSalt) {
    const keys = await deriveSessionKeys(masterKey, masterSalt);
    const subtle = getSubtle();
    const load = async ({ cipherKey, authKey, salt }) => ({
        cipher: await subtle.importKey('raw', cipherKey, 'AES-CTR', false, ['encrypt']),
        auth: await subtle.importKey('raw', authKey, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']),
        salt,
    });
    return new SrtpContext(subtle, await load(keys.rtp), await load(keys.rtcp));
}
