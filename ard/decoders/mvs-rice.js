/*
 * noVNC-ARD: ARD MVS Rice entropy coding.
 * DC Rice, AC Rice (standard and near-DC), AC special codes, and
 * quantization step selection.
 */

// Count consecutive 1-bits until a 0-bit
function readLeadingOnes(bs) {
    let count = 0;
    while (bs.readBit() === 1) {
        count++;
    }
    return count;
}

// DC Rice coding
export function decodeDCRice(bs) {
    const N = readLeadingOnes(bs);

    if (N === 0) {
        // Special: read 1 bit
        if (bs.readBit() === 0) return 0;
        // magnitude=1, read sign
        const sign = bs.readBit();
        return sign ? -1 : 1;
    }

    if (N === 1) {
        // k=1: magnitude = 2 + readBits(1)
        const mag = 2 + bs.readBits(1);
        const sign = bs.readBit();
        return sign ? -mag : mag;
    }

    if (N === 2) {
        // k=2: magnitude = 4 + readBits(2)
        const mag = 4 + bs.readBits(2);
        const sign = bs.readBit();
        return sign ? -mag : mag;
    }

    // N >= 3: k=3, magnitude = ((N<<3)|readBits(3)) - 16
    const mag = ((N << 3) | bs.readBits(3)) - 16;
    const sign = bs.readBit();
    return sign ? -mag : mag;
}

// AC Rice Standard (zigzag positions 6-63)
function decodeACRiceStandard(bs) {
    const N = readLeadingOnes(bs);

    if (N === 0) {
        // k=1: magnitude = 2 + readBits(1)
        const mag = 2 + bs.readBits(1);
        const sign = bs.readBit();
        return sign ? -mag : mag;
    }

    if (N === 1) {
        // k=2: magnitude = 4 + readBits(2)
        const mag = 4 + bs.readBits(2);
        const sign = bs.readBit();
        return sign ? -mag : mag;
    }

    // N >= 2: k=3, magnitude = ((N<<3)|readBits(3)) - 8
    const mag = ((N << 3) | bs.readBits(3)) - 8;
    const sign = bs.readBit();
    return sign ? -mag : mag;
}

// AC Rice Near-DC (zigzag positions 1-5)
function decodeACRiceNearDC(bs) {
    const N = readLeadingOnes(bs);

    if (N <= 3) {
        // k=2: magnitude = 2 + N*4 + readBits(2)
        const mag = 2 + N * 4 + bs.readBits(2);
        const sign = bs.readBit();
        return sign ? -mag : mag;
    }

    // N >= 4: k=3, magnitude = 18 + (N-4)*8 + readBits(3)
    const mag = 18 + (N - 4) * 8 + bs.readBits(3);
    const sign = bs.readBit();
    return sign ? -mag : mag;
}

// Quantization step selection
export function getQuantStep(zigzagPos, threshold) {
    if (zigzagPos <= 5) {
        // Positions 1-5
        if (threshold > 14) return 2;
        if (zigzagPos < threshold) return 8;
        return 16;
    }
    // Positions 6-63
    if (threshold > 14 && zigzagPos < threshold) return 2;
    if (threshold > 14) return 8;
    if (zigzagPos < threshold) return 8;
    return 16;
}

/**
 * Decode one AC coefficient from the bitstream.
 * @param {MvsBitstream} bs — body bitstream
 * @param {number} zigzagPos — current zigzag position (1-63)
 * @param {number} threshold — selected threshold value
 * @param {object} result — reusable {value, eob, skip} object (mutated in place)
 */
export function decodeACCoefficient(bs, zigzagPos, threshold, result) {
    result.value = 0;
    result.eob = false;
    result.skip = 0;

    const pathBit = bs.readBit();

    if (pathBit === 1) {
        // Rice path
        const raw = (zigzagPos <= 5)
            ? decodeACRiceNearDC(bs)
            : decodeACRiceStandard(bs);
        result.value = raw * getQuantStep(zigzagPos, threshold);
        return;
    }

    // AC Special path (pathBit === 0)
    const mode = bs.readBits(2);

    switch (mode) {
        case 0:
            // value = 0 (explicit zero)
            result.value = 0;
            break;
        case 1: {
            // EOB or skip run
            const subBit = bs.readBit();
            if (subBit === 0) {
                result.eob = true;
            } else {
                // Skip run length
                const ext = bs.readBits(2);
                if (ext < 3) {
                    result.skip = ext + 3; // 3, 4, or 5
                } else {
                    // ext == 3: extended run
                    let runLength = 6;
                    while (true) {
                        const chunk = bs.readBits(3);
                        runLength += chunk;
                        if (chunk < 7) break;
                        // A run never extends past the block
                        if (runLength + zigzagPos >= 64) break;
                    }
                    result.skip = runLength;
                }
            }
            break;
        }
        case 2:
            result.value = +getQuantStep(zigzagPos, threshold);
            break;
        case 3:
            result.value = -getQuantStep(zigzagPos, threshold);
            break;
    }
}
