/*
 * High Performance mode — playing decoded sound (DOM).
 *
 * An AudioContext at the stream's 48 kHz and a worklet holding a small
 * buffer (pcm-worklet.js). Browsers start an AudioContext suspended until
 * the user has interacted with the page; the sink resumes it at the next
 * click or key press if need be.
 */

export const SAMPLE_RATE = 48000;

export class AudioSink {
    static isSupported() {
        return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
    }

    static async create() {
        const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        try {
            await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
        } catch (e) {
            context.close();
            throw e;
        }
        return new AudioSink(context);
    }

    constructor(context) {
        this._context = context;
        this._node = new AudioWorkletNode(context, 'ard-pcm', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        this._node.connect(context.destination);
        this.buffer = null;     // latest report from the worklet
        this._node.port.onmessage = (e) => { this.buffer = e.data; };

        this._resume = this._resume.bind(this);
        if (context.state !== 'running') {
            context.resume().catch(() => {});
            window.addEventListener('pointerdown', this._resume, true);
            window.addEventListener('keydown', this._resume, true);
        }
    }

    _resume() {
        if (!this._context) return;
        this._context.resume().then(() => {
            if (this._context && this._context.state === 'running') this._stopWaiting();
        }, () => {});
    }

    _stopWaiting() {
        window.removeEventListener('pointerdown', this._resume, true);
        window.removeEventListener('keydown', this._resume, true);
    }

    get running() {
        return !!this._context && this._context.state === 'running';
    }

    // One block of stereo samples. The arrays are handed over, not copied.
    push(left, right) {
        if (!this._node) return;
        this._node.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    }

    close() {
        if (!this._context) return;
        this._stopWaiting();
        try { this._node.disconnect(); } catch (e) { /* already gone */ }
        this._context.close().catch(() => {});
        this._node = null;
        this._context = null;
    }
}
