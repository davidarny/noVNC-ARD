/*
 * noVNC-ARD: ARD MVS bitstream reader (MSB-first).
 */

export default class MvsBitstream {
    constructor(data, offset, length) {
        this._data = data;
        this._offset = offset;
        this._length = length;
        this._bytePos = 0;
        this._bitPos = 0;  // 0=MSB, 7=LSB
    }

    readBit() {
        if (this._bytePos >= this._length) {
            throw new Error("MvsBitstream: read past end");
        }
        const bit = (this._data[this._offset + this._bytePos] >> (7 - this._bitPos)) & 1;
        this._bitPos++;
        if (this._bitPos > 7) {
            this._bitPos = 0;
            this._bytePos++;
        }
        return bit;
    }

    readBits(n) {
        let value = 0;
        for (let i = 0; i < n; i++) {
            value = (value << 1) | this.readBit();
        }
        return value;
    }

    readByte() {
        return this.readBits(8);
    }
}
