/*
 * High Performance mode — audio packets in order.
 *
 * The server sends one AAC-ELD frame in each RTP packet, 100 a second,
 * silence included (ARD protocol spec, Section 14.11). Packets can arrive
 * out of order, and their decryption finishes out of order too. The
 * decoder needs them in sequence, and needs to know when one is missing.
 */

import { extendSeq } from './seq.js';

// The stream: AAC-ELD, stereo, 48 kHz, 480 samples (10 ms) a frame.
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_FRAME_SAMPLES = 480;

export class AudioReorder {
    /*
     * onFrame({ seq, timestamp, data, lost }): frames in sequence order.
     *   `lost` is the number of frames missing directly before this one.
     * depth: how many later packets may wait for a missing one before it
     *   is given up.
     */
    constructor({ onFrame, depth = 4 }) {
        this._onFrame = onFrame;
        this._depth = depth;
        this._waiting = new Map();      // extended seq → packet
        this._next = null;              // extended seq expected next
        this._highest = null;
        this.stats = { packets: 0, late: 0, duplicates: 0, lost: 0 };
    }

    push({ seq, timestamp, payload }) {
        this.stats.packets++;
        const ext = this._highest === null ? seq : extendSeq(this._highest, seq);
        if (this._highest === null || ext > this._highest) this._highest = ext;
        if (this._next === null) this._next = ext;

        if (ext < this._next) {
            this.stats.late++;
            return;
        }
        if (this._waiting.has(ext)) {
            this.stats.duplicates++;
            return;
        }
        this._waiting.set(ext, { seq, timestamp, data: payload });
        this._drain();
    }

    _drain() {
        for (;;) {
            const packet = this._waiting.get(this._next);
            if (packet) {
                this._waiting.delete(this._next);
                this._next++;
                this._onFrame(Object.assign(packet, { lost: 0 }));
                continue;
            }
            if (this._waiting.size <= this._depth) return;

            // Enough later packets are waiting: the missing ones are lost.
            let first = Infinity;
            for (const ext of this._waiting.keys()) {
                if (ext < first) first = ext;
            }
            const lost = first - this._next;
            this.stats.lost += lost;
            const next = this._waiting.get(first);
            this._waiting.delete(first);
            this._next = first + 1;
            this._onFrame(Object.assign(next, { lost }));
        }
    }
}
