/*
 * High Performance mode — sound: decrypted RTP packets in, sound out.
 *
 *   packets → AudioReorder → AacEldDecoder → AudioSink
 */

import { AudioReorder, AUDIO_FRAME_SAMPLES } from './rtp-audio.js';

// Never fill more than this many missing frames with silence at once.
const MAX_CONCEALED_FRAMES = 50;

export class AudioPipeline {
    /*
     * The decoder and the sink are created here unless given (tests give
     * their own). Rejects if either cannot be created, for instance when
     * the browser has no AudioWorklet.
     */
    static async create({ createDecoder, createSink } = {}) {
        if (!createDecoder) {
            const m = await import('./audio-decoder.js');
            createDecoder = () => m.AacEldDecoder.create();
        }
        if (!createSink) {
            const m = await import('./audio-sink.js');
            if (!m.AudioSink.isSupported()) throw new Error('no AudioWorklet');
            createSink = () => m.AudioSink.create();
        }
        const decoder = await createDecoder();
        let sink;
        try {
            sink = await createSink();
        } catch (e) {
            decoder.close();
            throw e;
        }
        return new AudioPipeline(decoder, sink);
    }

    constructor(decoder, sink) {
        this._decoder = decoder;
        this._sink = sink;
        this._queue = [];
        this._busy = false;
        this._closed = false;
        this.stats = { frames: 0, concealed: 0 };
        this._reorder = new AudioReorder({ onFrame: f => this._onFrame(f) });
    }

    get reorderStats() {
        return this._reorder.stats;
    }

    // One decrypted RTP packet: { seq, timestamp, payload }.
    push(rtp) {
        if (this._closed) return;
        this._reorder.push(rtp);
    }

    _onFrame(frame) {
        this._queue.push(frame);
        if (!this._busy) this._run();
    }

    // Decode what has queued up, one batch at a time, strictly in order.
    async _run() {
        this._busy = true;
        while (this._queue.length && !this._closed) {
            const batch = this._queue;
            this._queue = [];
            const decoded = await this._decoder.decode(batch.map(f => f.data));
            if (this._closed) break;

            // Silence stands in for frames that never arrived, before the
            // sound that follows them.
            const lost = Math.min(batch.reduce((n, f) => n + f.lost, 0), MAX_CONCEALED_FRAMES);
            for (let i = 0; i < lost; i++) {
                this._sink.push(new Float32Array(AUDIO_FRAME_SAMPLES), new Float32Array(AUDIO_FRAME_SAMPLES));
            }
            this.stats.concealed += lost;

            for (const pcm of decoded) {
                this._sink.push(pcm.left, pcm.right);
            }
            this.stats.frames += decoded.length;
        }
        this._busy = false;
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._queue = [];
        this._decoder.close();
        this._sink.close();
    }
}
