/*
 * High Performance mode — decoding and painting.
 *
 * The server sends the screen as horizontal stripes, each an HEVC picture,
 * all part of one bitstream (ARD protocol spec, Section 14.10). One
 * WebCodecs decoder takes the pictures in decoding order; each decoded
 * frame is painted into its stripe of an overlay canvas that covers
 * noVNC's own canvas. noVNC's canvas keeps handling input and the cursor.
 */

import { DEFAULT_CODEC, codecFromAnnexB } from './hevc.js';

function decoderConfig(codec) {
    return {
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
    };
}

export class VideoSink {
    // Whether this browser can decode the streams the server sends.
    static async isSupported(codec = DEFAULT_CODEC) {
        if (typeof VideoDecoder === 'undefined') return false;
        try {
            const result = await VideoDecoder.isConfigSupported(decoderConfig(codec));
            return !!result.supported;
        } catch (e) {
            return false;
        }
    }

    /*
     * target:  the canvas to cover (noVNC's)
     * width, height:  picture size from the server's answer
     * onFirstFrame():  the first decoded frame has been painted
     * onError(reason):  the decoder failed; the sink is unusable afterwards
     */
    constructor({ target, width, height, onFirstFrame, onError }) {
        this._target = target;
        this._onFirstFrame = onFirstFrame || (() => {});
        this._onError = onError || (() => {});
        this._stripeOf = new Map();     // chunk timestamp (don) → stripe
        this._decoder = null;
        this._painted = false;
        this._closed = false;
        this.stats = { submitted: 0, decoded: 0, dropped: 0 };

        this._canvas = document.createElement('canvas');
        this._canvas.width = width;
        this._canvas.height = height;
        this._canvas.className = 'noVNC_ard_hp_overlay';
        Object.assign(this._canvas.style, {
            position: 'absolute',
            pointerEvents: 'none',
            visibility: 'hidden',
        });
        this._ctx = this._canvas.getContext('2d', { alpha: false, desynchronized: true });
        target.insertAdjacentElement('afterend', this._canvas);

        this._align = this._align.bind(this);
        this._observer = new ResizeObserver(this._align);
        this._observer.observe(target);
        if (target.parentElement) this._observer.observe(target.parentElement);
        window.addEventListener('resize', this._align);
        this._align();
    }

    // Keep the overlay exactly over the canvas it covers.
    _align() {
        const t = this._target;
        Object.assign(this._canvas.style, {
            left: t.offsetLeft + 'px',
            top: t.offsetTop + 'px',
            width: t.clientWidth + 'px',
            height: t.clientHeight + 'px',
        });
    }

    _configure(codec) {
        this._decoder = new VideoDecoder({
            output: frame => this._paint(frame),
            error: (e) => {
                if (this._closed) return;
                this._onError('decoder: ' + (e && e.message ? e.message : e));
            },
        });
        this._decoder.configure(decoderConfig(codec));
    }

    _paint(frame) {
        const stripe = this._stripeOf.get(frame.timestamp);
        this._stripeOf.delete(frame.timestamp);
        if (stripe === undefined || this._closed) {
            frame.close();
            return;
        }
        this._ctx.drawImage(frame, 0, stripe * frame.displayHeight);
        frame.close();
        this.stats.decoded++;
        if (!this._painted) {
            this._painted = true;
            this._canvas.style.visibility = 'visible';
            this._align();
            this._onFirstFrame();
        }
    }

    // One picture from the assembler: { don, stripe, key, data }.
    push(picture) {
        if (this._closed) return;
        try {
            if (!this._decoder) {
                // Decoding can only start at a key picture, which carries
                // the parameter sets that name the codec.
                if (!picture.key) {
                    this.stats.dropped++;
                    return;
                }
                this._configure(codecFromAnnexB(picture.data) || DEFAULT_CODEC);
            }
            this._stripeOf.set(picture.don, picture.stripe);
            this._decoder.decode(new EncodedVideoChunk({
                type: picture.key ? 'key' : 'delta',
                timestamp: picture.don,
                data: picture.data,
            }));
            this.stats.submitted++;
        } catch (e) {
            this._onError('decode: ' + e.message);
        }
    }

    // Pictures handed to the decoder and not yet returned.
    get backlog() {
        return this._decoder ? this._decoder.decodeQueueSize : 0;
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._observer.disconnect();
        window.removeEventListener('resize', this._align);
        if (this._decoder && this._decoder.state !== 'closed') {
            try { this._decoder.close(); } catch (e) { /* already gone */ }
        }
        this._canvas.remove();
        this._stripeOf.clear();
    }
}
