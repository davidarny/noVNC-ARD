/*
 * High Performance mode — the little HEVC bitstream knowledge the viewer
 * needs: finding NAL units and naming the stream for WebCodecs.
 */

export const NAL_VPS = 32;

// Codec string of the streams observed so far: Range Extensions profile,
// high tier, level 5.1. Used when a stream's own VPS cannot be read.
export const DEFAULT_CODEC = 'hev1.4.10.H153.BE.08';

export function nalType(nal) {
    return (nal[0] >> 1) & 0x3f;
}

// Split an Annex B buffer (00 00 01 or 00 00 00 01 start codes) into NAL units.
export function splitAnnexB(data) {
    const starts = [];
    for (let i = 0; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            starts.push(i + 3);
            i += 2;
        }
    }
    const nals = [];
    for (let n = 0; n < starts.length; n++) {
        let end = n + 1 < starts.length ? starts[n + 1] - 3 : data.length;
        // A four-byte start code leaves one zero before the next unit.
        if (n + 1 < starts.length && end > starts[n] && data[end - 1] === 0) end--;
        nals.push(data.subarray(starts[n], end));
    }
    return nals;
}

// Remove emulation prevention bytes (00 00 03 → 00 00).
function unescape(nal) {
    const out = [];
    let zeros = 0;
    for (const b of nal) {
        if (zeros >= 2 && b === 3) {
            zeros = 0;
            continue;
        }
        out.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(out);
}

function reverseBits32(v) {
    let r = 0;
    for (let i = 0; i < 32; i++) {
        r = (r << 1) | ((v >>> i) & 1);
    }
    return r >>> 0;
}

/*
 * The WebCodecs codec string ("hev1.…", ISO/IEC 14496-15 Annex E) for a
 * stream, from the profile, tier and level in its VPS. Returns null when
 * the buffer holds no readable VPS.
 */
export function codecFromAnnexB(data) {
    const vps = splitAnnexB(data).find(nal => nal.length > 2 && nalType(nal) === NAL_VPS);
    if (!vps) return null;
    const b = unescape(vps);
    // 2 bytes NAL header, 4 bytes of VPS fields, then profile_tier_level.
    if (b.length < 6 + 12) return null;
    const ptl = b.subarray(6);

    const space = ptl[0] >> 6;
    const tier = (ptl[0] >> 5) & 1;
    const profile = ptl[0] & 0x1f;
    const compat = ((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0;
    const constraints = Array.from(ptl.subarray(5, 11));
    const level = ptl[11];

    while (constraints.length && constraints[constraints.length - 1] === 0) {
        constraints.pop();
    }

    let codec = 'hev1.' + ['', 'A', 'B', 'C'][space] + profile +
                '.' + reverseBits32(compat).toString(16).toUpperCase() +
                '.' + (tier ? 'H' : 'L') + level;
    for (const c of constraints) {
        codec += '.' + c.toString(16).toUpperCase().padStart(2, '0');
    }
    return codec;
}
