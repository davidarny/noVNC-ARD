/*
 * noVNC-ARD: ARD MVS 8×8 IDCT.
 * Integer port of libjpeg's jpeg_idct_islow, which is what the Apple
 * viewer uses, so the output is bit-exact.
 */

const CONST_BITS = 13;
const PASS1_BITS = 2;

const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

// Module-scoped workspace — allocated once, reused across calls
const _ws = new Int32Array(64);

// libjpeg range limit for IDCT output: level shift by 128 and clamp,
// wrapping wildly out-of-range values the way the 10-bit table does
function rangeLimit(v) {
    v &= 0x3FF;
    if (v < 128) return v + 128;
    if (v < 512) return 255;
    if (v < 896) return 0;
    return v - 896;
}

/**
 * The one sample value an 8×8 block has when only its DC coefficient is
 * set. Same result as idct8x8, without the transform.
 * @param {number} dc — dequantized DC coefficient
 */
export function idctFlat(dc) {
    return rangeLimit(((dc << PASS1_BITS) + (1 << (PASS1_BITS + 2))) >> (PASS1_BITS + 3));
}

/**
 * 8×8 inverse DCT.
 * @param {Int32Array} block — 64 dequantized coefficients in natural order
 * @param {Uint8Array} output — 64 samples (0..255) written in row-major order
 */
export function idct8x8(block, output) {
    const ws = _ws;

    // Pass 1: columns from input, results scaled up by PASS1_BITS
    for (let c = 0; c < 8; c++) {
        if (block[c + 8] === 0 && block[c + 16] === 0 && block[c + 24] === 0 &&
            block[c + 32] === 0 && block[c + 40] === 0 && block[c + 48] === 0 &&
            block[c + 56] === 0) {
            const dc = block[c] << PASS1_BITS;
            ws[c] = dc; ws[c + 8] = dc; ws[c + 16] = dc; ws[c + 24] = dc;
            ws[c + 32] = dc; ws[c + 40] = dc; ws[c + 48] = dc; ws[c + 56] = dc;
            continue;
        }

        let z2 = block[c + 16];
        let z3 = block[c + 48];
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 - z3 * FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;

        z2 = block[c];
        z3 = block[c + 32];
        let tmp0 = (z2 + z3) << CONST_BITS;
        let tmp1 = (z2 - z3) << CONST_BITS;

        const tmp10 = tmp0 + tmp3;
        const tmp13 = tmp0 - tmp3;
        const tmp11 = tmp1 + tmp2;
        const tmp12 = tmp1 - tmp2;

        tmp0 = block[c + 56];
        tmp1 = block[c + 40];
        tmp2 = block[c + 24];
        tmp3 = block[c + 8];

        z1 = tmp0 + tmp3;
        z2 = tmp1 + tmp2;
        z3 = tmp0 + tmp2;
        let z4 = tmp1 + tmp3;
        const z5 = (z3 + z4) * FIX_1_175875602;

        tmp0 *= FIX_0_298631336;
        tmp1 *= FIX_2_053119869;
        tmp2 *= FIX_3_072711026;
        tmp3 *= FIX_1_501321110;
        z1 *= -FIX_0_899976223;
        z2 *= -FIX_2_562915447;
        z3 = z3 * -FIX_1_961570560 + z5;
        z4 = z4 * -FIX_0_390180644 + z5;

        tmp0 += z1 + z3;
        tmp1 += z2 + z4;
        tmp2 += z2 + z3;
        tmp3 += z1 + z4;

        const shift = CONST_BITS - PASS1_BITS;
        const round = 1 << (shift - 1);
        ws[c]      = (tmp10 + tmp3 + round) >> shift;
        ws[c + 56] = (tmp10 - tmp3 + round) >> shift;
        ws[c + 8]  = (tmp11 + tmp2 + round) >> shift;
        ws[c + 48] = (tmp11 - tmp2 + round) >> shift;
        ws[c + 16] = (tmp12 + tmp1 + round) >> shift;
        ws[c + 40] = (tmp12 - tmp1 + round) >> shift;
        ws[c + 24] = (tmp13 + tmp0 + round) >> shift;
        ws[c + 32] = (tmp13 - tmp0 + round) >> shift;
    }

    // Pass 2: rows from workspace, descaled by PASS1_BITS + 3
    for (let r = 0; r < 64; r += 8) {
        let z2 = ws[r + 2];
        let z3 = ws[r + 6];
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 - z3 * FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;

        let tmp0 = (ws[r] + ws[r + 4]) << CONST_BITS;
        let tmp1 = (ws[r] - ws[r + 4]) << CONST_BITS;

        const tmp10 = tmp0 + tmp3;
        const tmp13 = tmp0 - tmp3;
        const tmp11 = tmp1 + tmp2;
        const tmp12 = tmp1 - tmp2;

        tmp0 = ws[r + 7];
        tmp1 = ws[r + 5];
        tmp2 = ws[r + 3];
        tmp3 = ws[r + 1];

        z1 = tmp0 + tmp3;
        z2 = tmp1 + tmp2;
        z3 = tmp0 + tmp2;
        let z4 = tmp1 + tmp3;
        const z5 = (z3 + z4) * FIX_1_175875602;

        tmp0 *= FIX_0_298631336;
        tmp1 *= FIX_2_053119869;
        tmp2 *= FIX_3_072711026;
        tmp3 *= FIX_1_501321110;
        z1 *= -FIX_0_899976223;
        z2 *= -FIX_2_562915447;
        z3 = z3 * -FIX_1_961570560 + z5;
        z4 = z4 * -FIX_0_390180644 + z5;

        tmp0 += z1 + z3;
        tmp1 += z2 + z4;
        tmp2 += z2 + z3;
        tmp3 += z1 + z4;

        const shift = CONST_BITS + PASS1_BITS + 3;
        const round = 1 << (shift - 1);
        output[r]     = rangeLimit((tmp10 + tmp3 + round) >> shift);
        output[r + 7] = rangeLimit((tmp10 - tmp3 + round) >> shift);
        output[r + 1] = rangeLimit((tmp11 + tmp2 + round) >> shift);
        output[r + 6] = rangeLimit((tmp11 - tmp2 + round) >> shift);
        output[r + 2] = rangeLimit((tmp12 + tmp1 + round) >> shift);
        output[r + 5] = rangeLimit((tmp12 - tmp1 + round) >> shift);
        output[r + 3] = rangeLimit((tmp13 + tmp0 + round) >> shift);
        output[r + 4] = rangeLimit((tmp13 - tmp0 + round) >> shift);
    }
}
