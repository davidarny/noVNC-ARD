/*
 * High Performance mode — decoding and painting.
 *
 * The server sends the screen as horizontal stripes, each an HEVC or an
 * H.264 picture, all part of one bitstream (ARD protocol spec, Section
 * 14.10). One
 * WebCodecs decoder takes the pictures in decoding order; each decoded
 * frame is painted into its stripe of an overlay canvas that covers
 * noVNC's own canvas. noVNC's canvas keeps handling input and the cursor.
 */

import * as hevc from './hevc.js';
import * as h264 from './h264.js';

// What the assembler calls a picture's format → how to name its stream
const FORMATS = { hevc, h264 };

function decoderConfig(codec) {
    return {
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
    };
}

/*
 * Where the overlay goes. noVNC's canvas does not always show the whole
 * framebuffer: when it clips, it shows the part `view` names, and the
 * pointer is mapped through the same numbers. The overlay holds the whole
 * picture, so it is sized and placed as the whole framebuffer would be and
 * cut down to the part the canvas shows.
 *
 * box:   the canvas on the page, CSS pixels: { left, top, width, height }
 * view:  { x, y, w, h, fbWidth, fbHeight } in framebuffer pixels, or null
 *        when not known, which is taken as the canvas showing everything
 * Returns { left, top, width, height, clip: { top, right, bottom, left } },
 * the clip measured inwards from the overlay's own edges.
 */
export function overlayGeometry(box, view) {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!view || !(view.w > 0 && view.h > 0 && view.fbWidth > 0 && view.fbHeight > 0)) {
        return { left: box.left, top: box.top, width: box.width, height: box.height, clip: none };
    }
    // CSS pixels per framebuffer pixel
    const sx = box.width / view.w;
    const sy = box.height / view.h;
    const width = view.fbWidth * sx;
    const height = view.fbHeight * sy;
    return {
        left: box.left - view.x * sx,
        top: box.top - view.y * sy,
        width,
        height,
        clip: {
            top: view.y * sy,
            right: Math.max(0, width - (view.x + view.w) * sx),
            bottom: Math.max(0, height - (view.y + view.h) * sy),
            left: view.x * sx,
        },
    };
}

export class VideoSink {
    // Whether this browser can decode the streams of one format, 'hevc' (what
    // an Apple silicon server sends) or 'h264' (an Intel server).
    static async isSupported(format = 'hevc') {
        if (typeof VideoDecoder === 'undefined' || !FORMATS[format]) return false;
        try {
            const result = await VideoDecoder.isConfigSupported(
                decoderConfig(FORMATS[format].DEFAULT_CODEC));
            return !!result.supported;
        } catch (e) {
            return false;
        }
    }

    /*
     * target:  the canvas to cover (noVNC's)
     * view():  optional; the part of the framebuffer the canvas shows, as
     *          overlayGeometry takes it
     * width, height:  picture size from the server's answer
     * onFirstFrame():  the first decoded frame has been painted
     * onError(reason):  the decoder failed; the sink is unusable afterwards
     */
    constructor({ target, view, width, height, onFirstFrame, onError }) {
        this._target = target;
        this._view = view || (() => null);
        this._viewKey = '';
        this._onFirstFrame = onFirstFrame || (() => {});
        this._onError = onError || (() => {});
        this._stripeOf = new Map();     // chunk timestamp (don) → stripe
        this._decoder = null;
        this.format = null;             // 'hevc' or 'h264' once the first key picture has come
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

        // Panning a clipped view changes what the canvas shows without
        // changing its size, and nothing announces it: look once a frame.
        this._watch = () => {
            if (this._closed) return;
            if (this._viewKey !== this._currentViewKey()) this._align();
            this._watchId = requestAnimationFrame(this._watch);
        };
        this._watchId = requestAnimationFrame(this._watch);
    }

    _currentViewKey() {
        const v = this._view();
        return v ? [v.x, v.y, v.w, v.h, v.fbWidth, v.fbHeight].join() : '';
    }

    // Keep the picture exactly where noVNC would draw the same pixels.
    _align() {
        const t = this._target;
        this._viewKey = this._currentViewKey();
        const g = overlayGeometry(
            { left: t.offsetLeft, top: t.offsetTop, width: t.clientWidth, height: t.clientHeight },
            this._view());
        const c = g.clip;
        Object.assign(this._canvas.style, {
            left: g.left + 'px',
            top: g.top + 'px',
            width: g.width + 'px',
            height: g.height + 'px',
            clipPath: (c.top || c.right || c.bottom || c.left)
                ? `inset(${c.top}px ${c.right}px ${c.bottom}px ${c.left}px)` : 'none',
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

    // One picture from the assembler: { don, stripe, key, format, data }.
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
                const format = FORMATS[picture.format] || hevc;
                this.format = picture.format || 'hevc';
                this._configure(format.codecFromAnnexB(picture.data) || format.DEFAULT_CODEC);
            }
            this._stripeOf.set(picture.don, picture.stripe);
            this._decoder.decode(new EncodedVideoChunk({
                type: picture.key ? 'key' : 'delta',
                timestamp: picture.don,
                // An H.264 decoder would otherwise hold pictures back
                data: this.format === 'h264' ? h264.withoutReordering(picture.data) : picture.data,
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
        cancelAnimationFrame(this._watchId);
        if (this._decoder && this._decoder.state !== 'closed') {
            try { this._decoder.close(); } catch (e) { /* already gone */ }
        }
        this._canvas.remove();
        this._stripeOf.clear();
    }
}
