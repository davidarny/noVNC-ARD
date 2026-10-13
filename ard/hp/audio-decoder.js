/*
 * High Performance mode — AAC-ELD decoding.
 *
 * No browser decodes AAC-ELD, so the page carries FFmpeg's AAC decoder
 * compiled to WebAssembly (ard/hp/vendor/libav, built by
 * tools/build-libav.sh). Decoding 10 ms of sound takes a few microseconds,
 * so it runs where it is called, without a worker.
 *
 * Stream parameters: ARD protocol spec, Section 14.11.
 */

import LibAVFactory from './vendor/libav/libav-6.10.9.0-ard-aac.mjs';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = 480;

// AAC-ELD, 48 kHz, stereo, 480 samples per frame, no SBR.
export const AUDIO_SPECIFIC_CONFIG = new Uint8Array([0xf8, 0xe6, 0x50, 0x00]);

const AV_CODEC_ID_AAC = 86018;
const LIBAV_BASE = new URL('./vendor/libav', import.meta.url).href;

export class AacEldDecoder {
    static async create() {
        const libav = await LibAVFactory.LibAV({ noworker: true, base: LIBAV_BASE });
        // The sample rate has to be given here: with the configuration
        // alone FFmpeg's decoder opens but rejects every frame.
        const [, context, packet, frame] = await libav.ff_init_decoder('aac', {
            codecpar: {
                codec_type: libav.AVMEDIA_TYPE_AUDIO,
                codec_id: AV_CODEC_ID_AAC,
                format: libav.AV_SAMPLE_FMT_FLTP,
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
                extradata: AUDIO_SPECIFIC_CONFIG,
            },
            time_base: [1, SAMPLE_RATE],
        });
        return new AacEldDecoder(libav, context, packet, frame);
    }

    constructor(libav, context, packet, frame) {
        this._libav = libav;
        this._context = context;
        this._packet = packet;
        this._frame = frame;
        this._pts = 0;
        this.stats = { frames: 0, errors: 0 };
    }

    /*
     * Decode access units, in order. Resolves to one { left, right } pair
     * of Float32Array per decoded frame. A unit the decoder cannot read
     * yields nothing and is counted.
     */
    async decode(units) {
        if (!this._libav) return [];
        const packets = units.map((data) => {
            const pts = this._pts;
            this._pts += FRAME_SAMPLES;
            return { data, pts, dts: pts };
        });
        let frames;
        try {
            frames = await this._libav.ff_decode_multi(
                this._context, this._packet, this._frame, packets,
                { fin: false, ignoreErrors: true });
        } catch (e) {
            this.stats.errors += units.length;
            return [];
        }
        this.stats.errors += units.length - frames.length;
        this.stats.frames += frames.length;
        return frames.map((f) => {
            const planes = f.data;
            return { left: planes[0], right: planes.length > 1 ? planes[1] : planes[0].slice() };
        });
    }

    close() {
        if (!this._libav) return;
        const libav = this._libav;
        this._libav = null;
        libav.ff_free_decoder(this._context, this._packet, this._frame).catch(() => {});
    }
}
