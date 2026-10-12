/*
 * noVNC-ARD: ARD MVS (encoding 1011) static tables.
 * Standard JPEG zigzag, default quantization tables and YCbCr tables.
 */

// Standard JPEG zigzag (libjpeg jpeg_natural_order): maps zigzag position →
// natural (row * 8 + col) index
export const MVS_ZIGZAG = new Uint8Array([
     0,  1,  8, 16,  9,  2,  3, 10, 17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
]);

// Default luma quantization table (natural order, same as the wire format)
export const DEFAULT_LUMA_QUANT = new Uint8Array([
    16, 11, 11, 14, 24, 22, 24, 33,
    11, 12, 11, 11, 26, 18, 19, 23,
    13, 13, 14, 24, 20, 21, 22, 28,
    13, 17, 14, 21, 23, 25, 34, 34,
    17, 22, 18, 25, 31, 32, 34, 44,
    24, 20, 17, 27, 35, 40, 44, 54,
    30, 35, 28, 30, 34, 44, 54, 64,
    35, 30, 33, 38, 45, 55, 65, 75
]);

// Default chroma quantization table (natural order, same as the wire format)
export const DEFAULT_CHROMA_QUANT = new Uint8Array([
    19, 19, 24, 47, 76, 99, 99, 99,
    19, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    76, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99
]);

// YCbCr → RGB lookup tables (libjpeg jdcolor.c, 16-bit fixed point),
// indexed by the level-shifted 0..255 chroma sample
export const CR_R_TAB = new Int32Array(256);
export const CB_B_TAB = new Int32Array(256);
export const CR_G_TAB = new Int32Array(256);
export const CB_G_TAB = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    const x = i - 128;
    CR_R_TAB[i] = (91881 * x + 32768) >> 16;    // 1.40200
    CB_B_TAB[i] = (116130 * x + 32768) >> 16;   // 1.77200
    CR_G_TAB[i] = -46802 * x;                   // 0.71414
    CB_G_TAB[i] = -22554 * x + 32768;           // 0.34414
}
