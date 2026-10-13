/*
 * noVNC-ARD: RTCP feedback for the high-performance video session
 *
 * Builders for the three packets the client sends: the receiver report,
 * the picture acknowledgement and the rate control report. Each returns
 * a plain RTCP packet; protecting it as SRTCP is the caller's job.
 */

const U8 = 0xff;
const U16 = 0xffff;
const U24 = 0xffffff;
const U32 = 0xffffffff;

// Bring a value into [0, max]: floored, and 0 if it is negative or not a
// finite number (Infinity included).
function clamp(value, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return n >= max ? max : Math.floor(n);
}

/**
 * Receiver report with one report block, followed by an SDES packet whose
 * only item is a CNAME of length 0. 44 bytes.
 *
 * ssrc is the sender of the report, sourceSsrc the stream reported on.
 * lsr is the middle 32 bits of the NTP time of the last sender report
 * received; dlsr is the delay since then in units of 1/65536 s.
 */
export function receiverReport({
    ssrc, sourceSsrc, highestSeq,
    jitter = 0, lsr = 0, dlsr = 0, fractionLost = 0, cumulativeLost = 0,
}) {
    const out = new Uint8Array(44);
    const dv = new DataView(out.buffer);
    const sender = clamp(ssrc, U32);

    // Receiver report: V=2, RC=1, PT=201, length 7 words
    dv.setUint32(0, 0x81c90007, false);
    dv.setUint32(4, sender, false);
    dv.setUint32(8, clamp(sourceSsrc, U32), false);
    dv.setUint32(12, clamp(fractionLost, U8) * 0x1000000 + clamp(cumulativeLost, U24), false);
    dv.setUint32(16, clamp(highestSeq, U32), false);
    dv.setUint32(20, clamp(jitter, U32), false);
    dv.setUint32(24, clamp(lsr, U32), false);
    dv.setUint32(28, clamp(dlsr, U32), false);

    // SDES: one chunk, length 2 words; CNAME item of length 0, then padding
    dv.setUint32(32, 0x81ca0002, false);
    dv.setUint32(36, sender, false);
    dv.setUint32(40, 0x01000000, false);

    return out;
}

/**
 * Picture acknowledgement: an APP packet naming the decoding order number
 * of a picture that was received. 16 bytes.
 */
export function pictureAck({ ssrc, don }) {
    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, 0x80cc0003, false);     // V=2, subtype 0, PT=204, length 3 words
    dv.setUint32(4, clamp(ssrc, U32), false);
    dv.setUint32(8, 0x00000005, false);     // APP name
    dv.setUint32(12, clamp(don, U32), false);

    return out;
}

/**
 * Rate control report: an APP packet named "RCTL". 32 bytes.
 *
 * The meaning of a, b, c and d is not settled; see the protocol
 * specification, section 14.12.
 */
export function rateControl({ ssrc, a, b, c, d }) {
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, 0x80cc0007, false);     // V=2, subtype 0, PT=204, length 7 words
    dv.setUint32(4, clamp(ssrc, U32), false);
    dv.setUint32(8, 0x5243544c, false);     // "RCTL"
    dv.setUint32(12, 0x85000004, false);
    dv.setUint16(16, clamp(a, U16), false);
    dv.setUint32(18, 0, false);
    dv.setUint16(22, clamp(b, U16), false);
    dv.setUint16(24, 0xffff, false);
    dv.setUint32(26, clamp(c, U32), false);
    dv.setUint16(30, clamp(d, U16), false);

    return out;
}
