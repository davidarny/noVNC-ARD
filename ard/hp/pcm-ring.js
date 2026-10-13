/*
 * High Performance mode — the buffer between the audio decoder and the
 * sound card.
 *
 * Decoded sound arrives in bursts as the network delivers it; the sound
 * card takes it at a fixed rate. The ring holds a small reserve so that
 * late packets do not become gaps, starts playing only once the reserve is
 * there, and throws away the oldest sound if it ever holds far too much,
 * so the delay cannot grow.
 */

export class PcmRing {
    /*
     * capacity: samples per channel the ring can hold
     * target:   reserve to build before playing, and to fall back to
     * limit:    more than this queued means the delay has grown; drop to target
     */
    constructor({ capacity = 24000, target = 3840, limit = 12000 } = {}) {
        this._left = new Float32Array(capacity);
        this._right = new Float32Array(capacity);
        this._capacity = capacity;
        this._target = target;
        this._limit = limit;
        this._read = 0;
        this._length = 0;
        this._playing = false;
        this.stats = { written: 0, played: 0, underruns: 0, dropped: 0 };
    }

    get length() {
        return this._length;
    }

    // Append one block of stereo samples.
    write(left, right) {
        let n = left.length;
        let from = 0;
        if (n > this._capacity) {
            from = n - this._capacity;
            this.stats.dropped += from;
            n = this._capacity;
        }
        const overflow = this._length + n - this._capacity;
        if (overflow > 0) this._discard(overflow);

        let w = (this._read + this._length) % this._capacity;
        for (let i = 0; i < n; i++) {
            this._left[w] = left[from + i];
            this._right[w] = right[from + i];
            if (++w === this._capacity) w = 0;
        }
        this._length += n;
        this.stats.written += n;

        if (this._length > this._limit) {
            this._discard(this._length - this._target);
        }
    }

    _discard(n) {
        n = Math.min(n, this._length);
        this._read = (this._read + n) % this._capacity;
        this._length -= n;
        this.stats.dropped += n;
    }

    // Fill one output block. Silence while the reserve is being built.
    read(left, right) {
        const n = left.length;
        if (!this._playing && this._length >= this._target) this._playing = true;
        if (this._playing && this._length < n) {
            this._playing = false;
            this.stats.underruns++;
        }
        if (!this._playing) {
            left.fill(0);
            right.fill(0);
            return false;
        }
        let r = this._read;
        for (let i = 0; i < n; i++) {
            left[i] = this._left[r];
            right[i] = this._right[r];
            if (++r === this._capacity) r = 0;
        }
        this._read = r;
        this._length -= n;
        this.stats.played += n;
        return true;
    }
}
