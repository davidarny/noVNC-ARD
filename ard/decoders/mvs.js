/*
 * noVNC-ARD: ARD MVS (encoding 1011) decoder.
 * DCT-based, 8x8 tiles. Follows the Apple viewer's DecodeMVSUpdate
 * (ScreenSharing.framework, RFBViewerLib/DecodeMultiVariant.c).
 */

import * as Log from "../../noVNC/core/util/logging.js";
import MvsBitstream from "./mvs-bitstream.js";
import { DEFAULT_LUMA_QUANT, DEFAULT_CHROMA_QUANT, MVS_ZIGZAG,
         CR_R_TAB, CB_B_TAB, CR_G_TAB, CB_G_TAB } from "./mvs-tables.js";
import { idct8x8, idctFlat } from "./mvs-idct.js";
import { decodeDCRice, decodeACCoefficient } from "./mvs-rice.js";
import { decodeHuffmanAC } from "./mvs-huffman.js";

// Truncate to signed int8 range [-128, 127]
function int8(v) {
    return ((v + 128) & 0xFF) - 128;
}

function clamp255(v) {
    return v < 0 ? 0 : (v > 255 ? 255 : v);
}

// Tile cache: ring buffer of tiles decoded by partial updates.
// Entry layout: Y[64] + Cr[15] + Cb[20], int8, zigzag order.
const CACHE_SIZE = 65000;
const CACHE_ENTRY_Y = 64;
const CACHE_ENTRY_CR = 15;
const CACHE_ENTRY_CB = 20;
const CACHE_ENTRY_SIZE = CACHE_ENTRY_Y + CACHE_ENTRY_CR + CACHE_ENTRY_CB; // 99

// Coefficient buffer layout: Y[0..63], Cb[64..127], Cr[128..191], zigzag order
const CB = 64;
const CR = 128;

export default class ArdMVSDecoder {
    constructor() {
        this._length = 0;
        this._lumaQuant = new Uint8Array(DEFAULT_LUMA_QUANT);
        this._chromaQuant = new Uint8Array(DEFAULT_CHROMA_QUANT);

        // Working coefficient buffer — zeroed per DCT tile
        this._coeffs = new Int16Array(192);

        // Coefficients of the previous DCT tile in the current full update
        this._dpcmState = new Int16Array(192);

        // AC decode result — reusable, no per-coefficient allocation
        this._acResult = { value: 0, eob: false, skip: 0 };

        // Per-tile RGBA output buffer (8×8×4 = 256 bytes), and the same
        // memory as whole pixels for copying
        this._tileBuf = new Uint8Array(256);
        this._tileBuf32 = new Uint32Array(this._tileBuf.buffer);

        // New cache entry built while decoding a partial DCT tile
        this._cacheEntry = new Int8Array(CACHE_ENTRY_SIZE);

        // IDCT working buffers
        this._dqBuf = new Int32Array(64);
        this._ySpatial = new Uint8Array(64);
        this._cbSpatial = new Uint8Array(64);
        this._crSpatial = new Uint8Array(64);

        // Full update type 4 colors (reset at the start of every full update)
        this._solid = new Uint8Array(3);
        this._twoColorA = new Uint8Array(3);
        this._twoColorB = new Uint8Array(3);

        this._cache = new Int8Array(CACHE_SIZE * CACHE_ENTRY_SIZE);
        this._cacheWriteIdx = 0; // most recently written slot (0 = none yet)
        this._cacheLastIdx = 0;  // most recently loaded slot
        this._cacheCount = 0;    // total number of inserts

        // Rendered pixels of cache slots that have been loaded, so that
        // loading a slot again does not transform it again. A slot's pixels
        // are current while its generation equals the quantization tables'.
        // Allocated on first use.
        this._cachePixels = null;    // Uint32Array (64 per slot)
        this._cachePixelGen = null;  // Uint32Array (0 = not rendered)
        this._quantGen = 1;

        // Decoded framebuffer (RGBA). Match tiles copy from it, so it has
        // to live here rather than only on the canvas.
        this._fb = null;
        this._fb32 = null;       // the same memory as whole pixels
        this._fbWidth = 0;
        this._fbHeight = 0;
        this._screenTilesX = 0;
        this._screenTilesTotal = 0;

        // Per-screen-tile descriptors. Written by full updates only; they
        // are the baseline that partial updates are coded against.
        this._tileDescThreshold = null;   // Uint8Array
        this._tileDescYCoeffs = null;     // Int8Array (64 * screenTilesTotal)
        this._tileDescCbValid = null;     // Uint8Array
        this._tileDescCbDC = null;        // Int8Array
        this._tileDescCrValid = null;     // Uint8Array
        this._tileDescCrDC = null;        // Int8Array
        this._tileDescFrameSeq = null;    // Uint32Array
        this._tileDescRefIndex = null;    // Int32Array
        this._tileDescMatchX = null;      // Int16Array
        this._tileDescMatchY = null;      // Int16Array

        // Frame sequence counter (incremented per full update)
        this._frameSeq = 0;
    }

    _ensureScreenState(display) {
        const fbW = display.width;
        const fbH = display.height;
        if (fbW === this._fbWidth && fbH === this._fbHeight) return;
        this._fbWidth = fbW;
        this._fbHeight = fbH;
        this._fb = new Uint8Array(fbW * fbH * 4);
        this._fb32 = new Uint32Array(this._fb.buffer);
        this._screenTilesX = Math.ceil(fbW / 8);
        const screenTilesY = Math.ceil(fbH / 8);
        this._screenTilesTotal = this._screenTilesX * screenTilesY;
        // Allocate flat arrays
        this._tileDescThreshold = new Uint8Array(this._screenTilesTotal);
        this._tileDescYCoeffs = new Int8Array(this._screenTilesTotal * 64);
        this._tileDescCbValid = new Uint8Array(this._screenTilesTotal);
        this._tileDescCbDC = new Int8Array(this._screenTilesTotal);
        this._tileDescCrValid = new Uint8Array(this._screenTilesTotal);
        this._tileDescCrDC = new Int8Array(this._screenTilesTotal);
        this._tileDescFrameSeq = new Uint32Array(this._screenTilesTotal);
        this._tileDescRefIndex = new Int32Array(this._screenTilesTotal);
        this._tileDescRefIndex.fill(-1);
        this._tileDescMatchX = new Int16Array(this._screenTilesTotal);
        this._tileDescMatchY = new Int16Array(this._screenTilesTotal);
    }

    decodeRect(x, y, width, height, sock, display, depth) {
        if (this._length === 0) {
            if (sock.rQwait("MVS", 4)) return false;
            this._length = sock.rQshift32();
        }

        if (sock.rQwait("MVS", this._length)) return false;
        const data = new Uint8Array(sock.rQshiftBytes(this._length, false));
        this._length = 0;

        this._ensureScreenState(display);

        const updateType = data[0];

        // A rectangle need not start on a multiple of 8: with several
        // displays combined, each display has its own tile grid, starting
        // at its own origin.
        if (updateType !== 0x02 &&
            (x + width > this._fbWidth || y + height > this._fbHeight)) {
            Log.Warn("MVS: bad rectangle " + width + "x" + height +
                     " at " + x + "," + y);
            return true;
        }

        switch (updateType) {
            case 0x02:
                this._handleQuantization(data);
                break;
            case 0x00:
                try {
                    this._handleFullUpdate(data, x, y, width, height);
                } catch (e) {
                    Log.Warn("MVS: full update failed: " + e.message +
                             " (dataLen=" + data.length + " " + width + "x" + height + ")");
                }
                this._blitRegion(display, x, y, width, height);
                break;
            case 0x01:
                try {
                    this._handlePartialUpdate(data, x, y, width, height, display);
                } catch (e) {
                    Log.Warn("MVS: partial update failed: " + e.message +
                             " (dataLen=" + data.length + " " + width + "x" + height + ")");
                }
                break;
            default:
                Log.Warn("MVS: unknown update type 0x" + updateType.toString(16));
                break;
        }

        return true;
    }

    _handleQuantization(data) {
        if (data.length !== 129) {
            Log.Warn("MVS: quantization packet is " + data.length +
                     " bytes, should be 129");
            return;
        }
        this._lumaQuant.set(data.subarray(1, 65));
        this._chromaQuant.set(data.subarray(65, 129));
        this._quantGen++;
    }

    _handleFullUpdate(data, x, y, width, height) {
        const threshold1 = data[1];
        const threshold2 = data[2];

        const tilesX = Math.ceil(width / 8);
        const tilesY = Math.ceil(height / 8);
        const totalTiles = tilesX * tilesY;

        // Body offset from bytes 3-5: 24-bit big-endian
        const bodyOffset = (data[3] << 16) | (data[4] << 8) | data[5];
        if (bodyOffset < 6 || bodyOffset > data.length) {
            throw new Error("invalid body offset " + bodyOffset);
        }

        // Tile types come RLE encoded from the header bitstream, tile
        // data from the body bitstream.
        const headerBits = new MvsBitstream(data, 6, bodyOffset - 6);
        const bodyBits = new MvsBitstream(data, bodyOffset, data.length - bodyOffset);

        // The header starts with one bit that the Apple viewer ignores
        headerBits.readBit();

        this._frameSeq++;
        this._dpcmState.fill(0);
        this._solid.fill(0);
        this._twoColorA.fill(255);
        this._twoColorB.set([181, 213, 254]);

        // Descriptor of the previous DCT tile in this update (P-frame source)
        let prevDctIdx = -1;
        // Position of the previous tile (left match source)
        let prevTileX = x;
        let prevTileY = y;

        let tileIdx = 0;
        while (tileIdx < totalTiles) {
            const tileType = headerBits.readBits(3);
            let count = 1;

            if (headerBits.readBit()) {
                const v4 = headerBits.readBits(4);
                if (v4 < 15) {
                    count = v4 + 2;
                } else {
                    const byte1 = headerBits.readBits(8);
                    let varint;
                    if ((byte1 & 0x80) === 0) {
                        varint = byte1;
                    } else {
                        const byte2 = headerBits.readBits(8);
                        if ((byte2 & 0x80) === 0) {
                            varint = (byte2 << 7) | (byte1 & 0x7F);
                        } else {
                            const byte3 = headerBits.readBits(8);
                            varint = (byte3 << 14) | ((byte2 & 0x7F) << 7) | (byte1 & 0x7F);
                        }
                    }
                    count = varint + 17;
                }
            }

            for (; count > 0 && tileIdx < totalTiles; count--, tileIdx++) {
                const tileCol = tileIdx % tilesX;
                const tileRow = (tileIdx - tileCol) / tilesX;
                const tileX = x + tileCol * 8;
                const tileY = y + tileRow * 8;
                const tileW = Math.min(8, x + width - tileX);
                const tileH = Math.min(8, y + height - tileY);
                const screenIdx = (tileY >> 3) * this._screenTilesX + (tileX >> 3);

                this._tileDescFrameSeq[screenIdx] = this._frameSeq;
                this._tileDescRefIndex[screenIdx] = -1;

                let rendered = true;

                switch (tileType) {
                    case 0: // White fill
                        this._tileBuf.fill(255);
                        break;

                    case 1: // Match the previous tile
                        this._tileDescRefIndex[screenIdx] = screenIdx - 1;
                        this._tileDescMatchX[screenIdx] = prevTileX;
                        this._tileDescMatchY[screenIdx] = prevTileY;
                        this._copyTile(prevTileX, prevTileY, tileX, tileY, tileW, tileH);
                        rendered = false;
                        break;

                    case 2: // Match the tile above
                        this._tileDescRefIndex[screenIdx] = screenIdx - this._screenTilesX;
                        this._tileDescMatchX[screenIdx] = tileX;
                        this._tileDescMatchY[screenIdx] = tileY - 8;
                        this._copyTile(tileX, tileY - 8, tileX, tileY, tileW, tileH);
                        rendered = false;
                        break;

                    case 3: // Black/white bitmap
                        this._decodeTwoColorBW(bodyBits);
                        break;

                    case 4: // Solid or two-color bitmap
                        this._decodeSolidOrTwoColor(bodyBits);
                        break;

                    case 5: // DCT encoded
                        this._decodeDCT(bodyBits, threshold1, threshold2,
                                        screenIdx, prevDctIdx);
                        prevDctIdx = screenIdx;
                        break;

                    case 6: // Cache by index
                        rendered = this._loadCacheAndRender(bodyBits.readBits(16));
                        break;

                    case 7: // Cache next
                        rendered = this._loadCacheAndRender(
                            (this._cacheLastIdx + 1) & 0xFFFF);
                        break;
                }

                if (rendered) {
                    this._putTile(tileX, tileY, tileW, tileH);
                }

                prevTileX = tileX;
                prevTileY = tileY;
            }
        }

        // Both bitstreams end with 'm' (0x6d), not byte-aligned
        const headerEnd = headerBits.readBits(8);
        if (headerEnd !== 0x6d) {
            Log.Warn("MVS: header expected 0x6d, got 0x" + headerEnd.toString(16));
        }
        const bodyEnd = bodyBits.readBits(8);
        if (bodyEnd !== 0x6d) {
            Log.Warn("MVS: body expected 0x6d, got 0x" + bodyEnd.toString(16));
        }
    }

    _handlePartialUpdate(data, x, y, width, height, display) {
        // AC position counts for the two chroma planes, in wire order
        const crACLimit = Math.min(data[1], 64);
        const cbACLimit = Math.min(data[2], 64);

        const tilesX = Math.ceil(width / 8);
        const tilesY = Math.ceil(height / 8);
        const totalTiles = tilesX * tilesY;

        const bs = new MvsBitstream(data, 3, data.length - 3);

        // Bounds of the tiles that changed
        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;

        try {
            for (let tileIdx = 0; tileIdx < totalTiles; tileIdx++) {
                const tileCol = tileIdx % tilesX;
                const tileRow = (tileIdx - tileCol) / tilesX;
                const tileX = x + tileCol * 8;
                const tileY = y + tileRow * 8;
                const tileW = Math.min(8, x + width - tileX);
                const tileH = Math.min(8, y + height - tileY);
                const screenIdx = (tileY >> 3) * this._screenTilesX + (tileX >> 3);

                let changed = false;

                switch (bs.readBits(2)) {
                    case 0: // Skip — tile unchanged
                        break;

                    case 1: // DCT, coded against the tile's descriptor
                        this._decodePartialDCT(bs, screenIdx, crACLimit, cbACLimit);
                        this._putTile(tileX, tileY, tileW, tileH);
                        changed = true;
                        break;

                    case 2: { // Match — copy from the tile recorded by the full update
                        const refIdx = this._tileDescRefIndex[screenIdx];
                        if (refIdx >= 0 && refIdx < this._screenTilesTotal &&
                            this._tileDescFrameSeq[screenIdx] === this._tileDescFrameSeq[refIdx]) {
                            this._copyTile(this._tileDescMatchX[screenIdx],
                                           this._tileDescMatchY[screenIdx],
                                           tileX, tileY, tileW, tileH);
                            changed = true;
                        }
                        break;
                    }

                    case 3: { // Cache
                        const cacheIdx = bs.readBit()
                            ? (this._cacheLastIdx + 1) & 0xFFFF
                            : bs.readBits(16);
                        if (this._loadCacheAndRender(cacheIdx)) {
                            this._putTile(tileX, tileY, tileW, tileH);
                            changed = true;
                        }
                        break;
                    }
                }

                if (changed) {
                    if (tileX < minX) minX = tileX;
                    if (tileY < minY) minY = tileY;
                    if (tileX + tileW > maxX) maxX = tileX + tileW;
                    if (tileY + tileH > maxY) maxY = tileY + tileH;
                }
            }

            // Ends with "mvs" (0x6d, 0x76, 0x73), not byte-aligned
            const m = bs.readByte();
            const v = bs.readByte();
            const s = bs.readByte();
            if (m !== 0x6d || v !== 0x76 || s !== 0x73) {
                Log.Warn("MVS partial: end marker mismatch: " +
                         m.toString(16) + " " + v.toString(16) + " " + s.toString(16));
            }
        } finally {
            if (maxX > minX) {
                this._blitRegion(display, minX, minY, maxX - minX, maxY - minY);
            }
        }
    }

    // --- Partial DCT decode ---

    _decodePartialDCT(bs, screenIdx, crACLimit, cbACLimit) {
        if (!this._tileDescCrValid[screenIdx] || !this._tileDescCbValid[screenIdx]) {
            throw new Error("partial DCT for a tile without a full update baseline");
        }

        const coeffs = this._coeffs;
        const entry = this._cacheEntry;
        const descY = this._tileDescYCoeffs;
        coeffs.fill(0);
        entry.fill(0);

        const threshold = this._tileDescThreshold[screenIdx];
        const descBase = screenIdx * 64;
        const descEnd = descBase + 64;

        // Y DC is taken from the descriptor unchanged
        coeffs[0] = descY[descBase];
        entry[0] = descY[descBase];

        // Y positions 1..acCount are coded
        const acCount = bs.readBits(6);
        const end = acCount + 1;

        // The baseline and the new cache entry are walked sequentially from
        // position 1, independently of the position being written
        let descPos = descBase + 1;
        let entryPos = 1;

        // Positions below the tile's threshold: small deltas
        const phase1End = Math.min(end, threshold);
        if (threshold < 15) {
            for (let pos = 1; pos < phase1End; pos++) {
                const prev = descPos < descEnd ? descY[descPos] : 0;
                descPos++;
                let value;
                if (prev === 0) {
                    value = int8(decodeDCRice(bs));
                } else {
                    const delta = bs.readBits(3);
                    value = int8(prev >= 0 ? prev + delta : prev - delta);
                }
                coeffs[pos] = value;
                entry[entryPos++] = value;
            }
        } else {
            for (let pos = 1; pos < phase1End; pos++) {
                const prev = descPos < descEnd ? descY[descPos] : 0;
                descPos++;
                let value = 0;
                if (prev === 0) {
                    if (bs.readBit()) {
                        value = bs.readBit() ? -1 : 1;
                    }
                } else {
                    const delta = bs.readBit();
                    value = int8(prev >= 0 ? prev + delta : prev - delta);
                }
                coeffs[pos] = value;
                entry[entryPos++] = value;
            }
        }

        // Positions from the threshold up: wider deltas
        if (acCount >= threshold) {
            const deltaBits = threshold < 15 ? 4 : 3;
            for (let pos = threshold; pos < end; pos++) {
                const prev = descPos < descEnd ? descY[descPos] : 0;
                descPos++;
                let value;
                if (prev === 0) {
                    value = int8(decodeDCRice(bs));
                } else {
                    const delta = bs.readBits(deltaBits);
                    value = int8(prev >= 0 ? prev + delta : prev - delta);
                }
                coeffs[pos] = value;
                entry[entryPos++] = value;
            }
        }

        // Cr, then Cb: DC as a one-step delta, AC Huffman coded
        coeffs[CR] = this._decodeChromaDCDelta(bs, this._tileDescCrDC[screenIdx]);
        decodeHuffmanAC(bs, coeffs, CR, crACLimit);
        for (let i = 0; i < CACHE_ENTRY_CR; i++) {
            entry[CACHE_ENTRY_Y + i] = coeffs[CR + i];
        }

        coeffs[CB] = this._decodeChromaDCDelta(bs, this._tileDescCbDC[screenIdx]);
        decodeHuffmanAC(bs, coeffs, CB, cbACLimit);
        for (let i = 0; i < CACHE_ENTRY_CB; i++) {
            entry[CACHE_ENTRY_Y + CACHE_ENTRY_CR + i] = coeffs[CB + i];
        }

        this._dequantAndRender();

        // Only partial DCT tiles enter the cache. The descriptor is left
        // alone, so later partial updates are still coded against the
        // last full update.
        this._cacheWriteIdx++;
        if (this._cacheWriteIdx === CACHE_SIZE) {
            this._cacheWriteIdx = 1;
        }
        this._cacheCount++;
        this._cache.set(entry, this._cacheWriteIdx * CACHE_ENTRY_SIZE);
        if (this._cachePixelGen !== null) {
            this._cachePixelGen[this._cacheWriteIdx] = 0;
        }
    }

    _decodeChromaDCDelta(bs, baseline) {
        const bit = bs.readBit();
        if (baseline !== 0) {
            return int8(baseline >= 0 ? baseline + bit : baseline - bit);
        }
        if (bit) {
            return bs.readBit() ? -1 : 1;
        }
        return 0;
    }

    // --- Tile type handlers (all write to this._tileBuf) ---

    _decodeTwoColorBW(bs) {
        const rowSelector = bs.readBits(8);

        for (let row = 0; row < 8; row++) {
            if ((rowSelector >> (7 - row)) & 1) {
                // Entire row is white
                for (let col = 0; col < 8; col++) {
                    const off = (row * 8 + col) * 4;
                    this._tileBuf[off] = 255;
                    this._tileBuf[off + 1] = 255;
                    this._tileBuf[off + 2] = 255;
                    this._tileBuf[off + 3] = 255;
                }
            } else {
                // Per-pixel bits
                const pixelBits = bs.readBits(8);
                for (let col = 0; col < 8; col++) {
                    const off = (row * 8 + col) * 4;
                    const white = (pixelBits >> (7 - col)) & 1;
                    const val = white ? 255 : 0;
                    this._tileBuf[off] = val;
                    this._tileBuf[off + 1] = val;
                    this._tileBuf[off + 2] = val;
                    this._tileBuf[off + 3] = 255;
                }
            }
        }
    }

    _decodeSolidOrTwoColor(bs) {
        const twoColor = bs.readBit();
        const reuse = bs.readBit();

        if (!twoColor) {
            if (!reuse) {
                this._readYCbCr20(bs, this._solid);
            }
            for (let off = 0; off < 256; off += 4) {
                this._tileBuf[off] = this._solid[0];
                this._tileBuf[off + 1] = this._solid[1];
                this._tileBuf[off + 2] = this._solid[2];
                this._tileBuf[off + 3] = 255;
            }
        } else {
            if (!reuse) {
                this._readYCbCr20(bs, this._twoColorA);
                this._readYCbCr20(bs, this._twoColorB);
            }
            this._renderTwoColorBitmap(bs, this._twoColorA, this._twoColorB);
        }
    }

    _readYCbCr20(bs, rgb) {
        const y = bs.readBits(8);
        const cb = bs.readBits(6) << 2;
        const cr = bs.readBits(6) << 2;
        rgb[0] = clamp255(y + CR_R_TAB[cr]);
        rgb[1] = clamp255(y + ((CB_G_TAB[cb] + CR_G_TAB[cr]) >> 16));
        rgb[2] = clamp255(y + CB_B_TAB[cb]);
    }

    _renderTwoColorBitmap(bs, colorA, colorB) {
        const rowSelector = bs.readBits(8);

        for (let row = 0; row < 8; row++) {
            // Entire row is color A, or per-pixel bits
            const pixelBits = ((rowSelector >> (7 - row)) & 1)
                ? 0xFF : bs.readBits(8);
            for (let col = 0; col < 8; col++) {
                const off = (row * 8 + col) * 4;
                const color = ((pixelBits >> (7 - col)) & 1) ? colorA : colorB;
                this._tileBuf[off] = color[0];
                this._tileBuf[off + 1] = color[1];
                this._tileBuf[off + 2] = color[2];
                this._tileBuf[off + 3] = 255;
            }
        }
    }

    // --- DCT decode (full update) ---

    _decodeDCT(bs, threshold1, threshold2, screenIdx, prevDctIdx) {
        const coeffs = this._coeffs;
        const state = this._dpcmState;
        const acResult = this._acResult;

        coeffs.fill(0);

        if (bs.readBit()) {
            // Repeat of the previous DCT tile: same coefficients, and the
            // whole descriptor is inherited, threshold included
            if (prevDctIdx < 0) {
                Log.Warn("MVS: repeat tile without a previous DCT tile");
            } else {
                for (let i = 0; i < 64; i++) {
                    coeffs[i] = state[i];
                }
                coeffs[CB] = state[CB];
                coeffs[CR] = state[CR];
                this._copyTileDesc(prevDctIdx, screenIdx);
            }
        } else {
            const dcMode = bs.readBit();
            const threshold = bs.readBit() ? threshold2 : threshold1;

            // DC decode: Cb, Cr, Y order, predicted from the previous DCT tile
            if (dcMode === 0) {
                const cbRice = decodeDCRice(bs);
                const cbHalf = (state[CB] + (state[CB] < 0 ? 1 : 0)) >> 1;
                coeffs[CB] = (cbHalf - cbRice) * 2;

                const crRice = decodeDCRice(bs);
                const crHalf = (state[CR] + (state[CR] < 0 ? 1 : 0)) >> 1;
                coeffs[CR] = (crHalf - crRice) * 2;
            } else {
                coeffs[CB] = state[CB];
                coeffs[CR] = state[CR];
            }
            coeffs[0] = state[0] - decodeDCRice(bs);

            // Y AC (zigzag positions 1-63)
            let pos = 1;
            while (pos < 64) {
                decodeACCoefficient(bs, pos, threshold, acResult);
                if (acResult.eob) break;
                if (acResult.skip > 0) {
                    pos += acResult.skip;
                } else {
                    coeffs[pos] = acResult.value;
                    pos++;
                }
            }

            // The descriptor keeps the int8-truncated coefficients
            this._tileDescThreshold[screenIdx] = threshold;
            const descY = this._tileDescYCoeffs;
            const descBase = screenIdx * 64;
            for (let i = 0; i < 64; i++) {
                descY[descBase + i] = coeffs[i];
            }
            this._tileDescCbValid[screenIdx] = 1;
            this._tileDescCbDC[screenIdx] = coeffs[CB];
            this._tileDescCrValid[screenIdx] = 1;
            this._tileDescCrDC[screenIdx] = coeffs[CR];
        }

        state.set(coeffs);

        this._dequantAndRender();
    }

    _copyTileDesc(from, to) {
        this._tileDescThreshold[to] = this._tileDescThreshold[from];
        this._tileDescYCoeffs.copyWithin(to * 64, from * 64, from * 64 + 64);
        this._tileDescCbValid[to] = this._tileDescCbValid[from];
        this._tileDescCbDC[to] = this._tileDescCbDC[from];
        this._tileDescCrValid[to] = this._tileDescCrValid[from];
        this._tileDescCrDC[to] = this._tileDescCrDC[from];
        this._tileDescFrameSeq[to] = this._tileDescFrameSeq[from];
        this._tileDescRefIndex[to] = this._tileDescRefIndex[from];
        this._tileDescMatchX[to] = this._tileDescMatchX[from];
        this._tileDescMatchY[to] = this._tileDescMatchY[from];
    }

    // --- Cache operations ---

    // Renders a cached tile to _tileBuf. Returns false, leaving the tile
    // alone, if the slot has never been written.
    _loadCacheAndRender(idx) {
        if (idx === 0 || idx > CACHE_SIZE || idx > this._cacheCount) {
            Log.Warn("MVS: cache index " + idx + " out of range (" +
                     this._cacheCount + " cached)");
            return false;
        }

        if (this._cachePixels === null) {
            this._cachePixels = new Uint32Array((CACHE_SIZE + 1) * 64);
            this._cachePixelGen = new Uint32Array(CACHE_SIZE + 1);
        }
        const tile = this._tileBuf32;
        const pixels = this._cachePixels;
        const pixelBase = idx * 64;

        if (this._cachePixelGen[idx] === this._quantGen) {
            for (let i = 0; i < 64; i++) {
                tile[i] = pixels[pixelBase + i];
            }
        } else {
            const coeffs = this._coeffs;
            const cache = this._cache;
            const base = idx * CACHE_ENTRY_SIZE;
            coeffs.fill(0);

            for (let i = 0; i < CACHE_ENTRY_Y; i++) {
                coeffs[i] = cache[base + i];
            }
            for (let i = 0; i < CACHE_ENTRY_CR; i++) {
                coeffs[CR + i] = cache[base + CACHE_ENTRY_Y + i];
            }
            for (let i = 0; i < CACHE_ENTRY_CB; i++) {
                coeffs[CB + i] = cache[base + CACHE_ENTRY_Y + CACHE_ENTRY_CR + i];
            }

            this._dequantAndRender();

            for (let i = 0; i < 64; i++) {
                pixels[pixelBase + i] = tile[i];
            }
            this._cachePixelGen[idx] = this._quantGen;
        }

        this._cacheLastIdx = idx;
        return true;
    }

    // --- Dequantize + IDCT + Color Convert (all 3 planes, writes to _tileBuf) ---

    _dequantAndRender() {
        const ySpatial = this._ySpatial;
        const yFlat = this._transformPlane(0, this._lumaQuant, ySpatial);
        if (yFlat >= 0) ySpatial.fill(yFlat);

        const cbFlat = this._transformPlane(CB, this._chromaQuant, this._cbSpatial);
        const crFlat = this._transformPlane(CR, this._chromaQuant, this._crSpatial);

        const tileBuf = this._tileBuf;

        if (cbFlat >= 0 && crFlat >= 0) {
            // One color for the whole tile, which is the usual case
            const rAdd = CR_R_TAB[crFlat];
            const gAdd = (CB_G_TAB[cbFlat] + CR_G_TAB[crFlat]) >> 16;
            const bAdd = CB_B_TAB[cbFlat];
            for (let i = 0; i < 64; i++) {
                const yVal = ySpatial[i];
                const off = i * 4;
                tileBuf[off] = clamp255(yVal + rAdd);
                tileBuf[off + 1] = clamp255(yVal + gAdd);
                tileBuf[off + 2] = clamp255(yVal + bAdd);
                tileBuf[off + 3] = 255;
            }
            return;
        }

        if (cbFlat >= 0) this._cbSpatial.fill(cbFlat);
        if (crFlat >= 0) this._crSpatial.fill(crFlat);

        for (let i = 0; i < 64; i++) {
            const yVal = ySpatial[i];
            const cb = this._cbSpatial[i];
            const cr = this._crSpatial[i];

            const off = i * 4;
            tileBuf[off] = clamp255(yVal + CR_R_TAB[cr]);
            tileBuf[off + 1] = clamp255(yVal + ((CB_G_TAB[cb] + CR_G_TAB[cr]) >> 16));
            tileBuf[off + 2] = clamp255(yVal + CB_B_TAB[cb]);
            tileBuf[off + 3] = 255;
        }
    }

    // Dequantize and transform one plane of _coeffs into `out`. A plane
    // with only its DC coefficient set is one flat value: that value is
    // returned and `out` is left alone. Otherwise returns -1.
    _transformPlane(plane, quant, out) {
        const coeffs = this._coeffs;
        const dqBuf = this._dqBuf;

        let ac = 0;
        for (let i = 1; i < 64; i++) {
            const n = MVS_ZIGZAG[i];
            const value = coeffs[plane + i];
            ac |= value;
            dqBuf[n] = value * quant[n];
        }
        const dc = coeffs[plane] * quant[0];
        if (ac === 0) {
            return idctFlat(dc);
        }
        dqBuf[0] = dc;
        idct8x8(dqBuf, out);
        return -1;
    }

    // --- Framebuffer ---

    // Write _tileBuf to the framebuffer
    _putTile(tileX, tileY, tileW, tileH) {
        const fb = this._fb32;
        const tile = this._tileBuf32;
        let dst = tileY * this._fbWidth + tileX;
        for (let row = 0; row < tileH; row++) {
            const src = row * 8;
            for (let col = 0; col < tileW; col++) {
                fb[dst + col] = tile[src + col];
            }
            dst += this._fbWidth;
        }
    }

    // Copy a tile within the framebuffer. A source outside the framebuffer
    // leaves the destination as it is.
    _copyTile(srcX, srcY, dstX, dstY, tileW, tileH) {
        if (srcX < 0 || srcY < 0) return;
        const fb = this._fb;
        const stride = this._fbWidth * 4;
        const rowBytes = Math.min(tileW, this._fbWidth - srcX) * 4;
        let src = (srcY * this._fbWidth + srcX) * 4;
        let dst = (dstY * this._fbWidth + dstX) * 4;
        for (let row = 0; row < tileH && srcY + row < this._fbHeight; row++) {
            fb.copyWithin(dst, src, src + rowBytes);
            src += stride;
            dst += stride;
        }
    }

    // Send a region of the framebuffer to the display
    _blitRegion(display, x, y, width, height) {
        if (x === 0 && y === 0 && width === this._fbWidth) {
            display.blitImage(0, 0, width, height, this._fb, 0);
            return;
        }
        const region = new Uint8Array(width * height * 4);
        const stride = this._fbWidth * 4;
        const rowBytes = width * 4;
        let src = (y * this._fbWidth + x) * 4;
        for (let row = 0; row < height; row++) {
            region.set(this._fb.subarray(src, src + rowBytes), row * rowBytes);
            src += stride;
        }
        display.blitImage(x, y, width, height, region, 0);
    }
}
