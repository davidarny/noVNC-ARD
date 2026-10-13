/*
 * Unit tests for High Performance audio: packet reordering, the playback
 * buffer, the pipeline, and the WebAssembly AAC-ELD decoder.
 * All data here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-audio.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import { AudioReorder, AUDIO_FRAME_SAMPLES } from '../hp/rtp-audio.js';
import { PcmRing } from '../hp/pcm-ring.js';
import { AudioPipeline } from '../hp/audio.js';
import { AacEldDecoder } from '../hp/audio-decoder.js';

function packet(seq) {
    return { seq: seq & 0xffff, timestamp: seq * 480, payload: new Uint8Array([seq & 0xff]) };
}

function collect(depth) {
    const out = [];
    const reorder = new AudioReorder({ depth, onFrame: f => out.push([f.seq, f.lost]) });
    return { out, reorder };
}

function block(n, value) {
    return new Float32Array(n).fill(value);
}

describe('Audio packet order', () => {
    it('passes packets that arrive in order straight through', () => {
        const { out, reorder } = collect();
        for (const s of [10, 11, 12]) reorder.push(packet(s));
        deepStrictEqual(out, [[10, 0], [11, 0], [12, 0]]);
    });

    it('puts packets that arrive out of order back in sequence', () => {
        const { out, reorder } = collect();
        for (const s of [10, 12, 13, 11, 14]) reorder.push(packet(s));
        deepStrictEqual(out, [[10, 0], [11, 0], [12, 0], [13, 0], [14, 0]]);
    });

    it('gives up on a missing packet once enough later ones wait, and says how many were lost', () => {
        const { out, reorder } = collect(3);
        for (const s of [10, 13, 14, 15]) reorder.push(packet(s));
        deepStrictEqual(out, [[10, 0]]);
        reorder.push(packet(16));
        deepStrictEqual(out, [[10, 0], [13, 2], [14, 0], [15, 0], [16, 0]]);
        strictEqual(reorder.stats.lost, 2);
    });

    it('drops duplicates and packets that arrive after their turn', () => {
        const { out, reorder } = collect(2);
        for (const s of [10, 12, 12, 13, 14]) reorder.push(packet(s));
        reorder.push(packet(11));
        deepStrictEqual(out, [[10, 0], [12, 1], [13, 0], [14, 0]]);
        strictEqual(reorder.stats.duplicates, 1);
        strictEqual(reorder.stats.late, 1);
    });

    it('takes a restarted stream as a new baseline after reset', () => {
        const { out, reorder } = collect();
        for (const s of [6659, 6660]) reorder.push(packet(s));
        deepStrictEqual(out, [[6659, 0], [6660, 0]]);
        // The stream restarts with a low sequence; without reset these read
        // as late and are dropped.
        reorder.push(packet(5760));
        strictEqual(reorder.stats.late, 1);
        reorder.reset();
        for (const s of [5760, 5761, 5762]) reorder.push(packet(s));
        deepStrictEqual(out, [[6659, 0], [6660, 0], [5760, 0], [5761, 0], [5762, 0]]);
    });

    it('follows the sequence number through its wrap', () => {
        const { out, reorder } = collect();
        for (const s of [65534, 65535, 65536, 65537]) reorder.push(packet(s));
        deepStrictEqual(out, [[65534, 0], [65535, 0], [0, 0], [1, 0]]);
        const again = collect();
        for (const s of [65535, 65537, 65536]) again.reorder.push(packet(s));
        deepStrictEqual(again.out, [[65535, 0], [0, 0], [1, 0]]);
    });
});

describe('Playback buffer', () => {
    it('plays silence until its reserve is built, then the sound in order', () => {
        const ring = new PcmRing({ capacity: 1000, target: 300, limit: 600 });
        const left = new Float32Array(128), right = new Float32Array(128);
        ring.write(block(200, 0.5), block(200, -0.5));
        strictEqual(ring.read(left, right), false);
        strictEqual(left[0], 0);
        ring.write(block(200, 0.25), block(200, -0.25));
        strictEqual(ring.read(left, right), true);
        strictEqual(left[0], 0.5);
        strictEqual(right[127], -0.5);
        ring.read(left, right);
        strictEqual(left[71], 0.5);
        strictEqual(left[72], 0.25);
        strictEqual(ring.length, 400 - 256);
    });

    it('goes quiet on an underrun and rebuilds its reserve', () => {
        const ring = new PcmRing({ capacity: 1000, target: 256, limit: 600 });
        const left = new Float32Array(128), right = new Float32Array(128);
        ring.write(block(256, 1), block(256, 1));
        strictEqual(ring.read(left, right), true);
        strictEqual(ring.read(left, right), true);
        strictEqual(ring.read(left, right), false);
        strictEqual(ring.stats.underruns, 1);
        ring.write(block(128, 1), block(128, 1));
        strictEqual(ring.read(left, right), false, 'still below the reserve');
        ring.write(block(128, 1), block(128, 1));
        strictEqual(ring.read(left, right), true);
    });

    it('drops the oldest sound when too much has queued', () => {
        const ring = new PcmRing({ capacity: 1000, target: 200, limit: 500 });
        ring.write(block(400, 0.1), block(400, 0.1));
        ring.write(block(200, 0.9), block(200, 0.9));
        strictEqual(ring.length, 200);
        strictEqual(ring.stats.dropped, 400);
        const left = new Float32Array(128), right = new Float32Array(128);
        ring.read(left, right);
        ok(Math.abs(left[0] - 0.9) < 1e-6);
    });

    it('wraps around its storage without losing or repeating samples', () => {
        const ring = new PcmRing({ capacity: 300, target: 128, limit: 290 });
        const left = new Float32Array(128), right = new Float32Array(128);
        let next = 0, expect = 0;
        for (let round = 0; round < 40; round++) {
            const l = new Float32Array(128);
            for (let i = 0; i < 128; i++) l[i] = next++;
            ring.write(l, l);
            ok(ring.read(left, right));
            for (let i = 0; i < 128; i++) strictEqual(left[i], expect++);
        }
    });

    it('survives a block larger than itself', () => {
        const ring = new PcmRing({ capacity: 100, target: 50, limit: 90 });
        ring.write(block(250, 0.3), block(250, 0.3));
        ok(ring.length <= 100);
    });
});

describe('Audio pipeline', () => {
    function fakes(delayed) {
        const played = [];
        const decoder = {
            closed: false,
            async decode(units) {
                if (delayed) await new Promise(resolve => setImmediate(resolve));
                return units.map(u => ({ left: block(480, u[0]), right: block(480, u[0]) }));
            },
            close() { this.closed = true; },
        };
        const sink = { closed: false, push(left) { played.push(left[0]); }, close() { this.closed = true; } };
        return { played, decoder, sink };
    }

    async function settle() {
        for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    }

    it('plays frames in sequence order however they arrive and however slowly they decode', async () => {
        const { played, decoder, sink } = fakes(true);
        const pipeline = new AudioPipeline(decoder, sink);
        for (const s of [1, 3, 2, 4, 6, 5, 7]) pipeline.push(packet(s));
        await settle();
        deepStrictEqual(played, [1, 2, 3, 4, 5, 6, 7]);
        strictEqual(pipeline.stats.frames, 7);
    });

    it('fills a gap with silence', async () => {
        const { played, decoder, sink } = fakes(false);
        const pipeline = new AudioPipeline(decoder, sink);
        for (const s of [1, 4, 5, 6, 7, 8]) pipeline.push(packet(s));
        await settle();
        deepStrictEqual(played, [1, 0, 0, 4, 5, 6, 7, 8]);
        strictEqual(pipeline.stats.concealed, 2);
    });

    it('closes its decoder and sink and then ignores packets', async () => {
        const { played, decoder, sink } = fakes(true);
        const pipeline = new AudioPipeline(decoder, sink);
        pipeline.push(packet(1));
        pipeline.close();
        pipeline.push(packet(2));
        await settle();
        ok(decoder.closed && sink.closed);
        deepStrictEqual(played, []);
    });

    it('passes mute on to the sink', () => {
        const { decoder, sink } = fakes(false);
        const seen = [];
        sink.setMuted = m => seen.push(m);
        const pipeline = new AudioPipeline(decoder, sink);
        pipeline.setMuted(true);
        pipeline.setMuted(0);
        pipeline.close();
        pipeline.setMuted(true);
        deepStrictEqual(seen, [true, false]);
    });

    it('closes the decoder when the sink cannot be created', async () => {
        const { decoder } = fakes(false);
        let failed = false;
        await AudioPipeline.create({
            createDecoder: async () => decoder,
            createSink: async () => { throw new Error('no audio device'); },
        }).catch(() => { failed = true; });
        ok(failed);
        ok(decoder.closed);
    });
});

describe('AAC-ELD decoder (WebAssembly)', () => {
    // The frame the server sends for silence (ARD protocol spec, 14.11).
    const SILENT_FRAME = new Uint8Array([0x00, 0x68, 0x34, 0x00]);

    it('decodes silent frames to 480 stereo samples of silence each', async () => {
        const decoder = await AacEldDecoder.create();
        const pcm = await decoder.decode(Array.from({ length: 10 }, () => SILENT_FRAME.slice()));
        strictEqual(pcm.length, 10);
        for (const { left, right } of pcm) {
            ok(left instanceof Float32Array && right instanceof Float32Array);
            strictEqual(left.length, AUDIO_FRAME_SAMPLES);
            strictEqual(right.length, AUDIO_FRAME_SAMPLES);
            ok(left.every(v => v === 0) && right.every(v => v === 0));
        }
        strictEqual(decoder.stats.frames, 10);
        decoder.close();
    });

    it('carries on after a unit it cannot decode', async () => {
        const decoder = await AacEldDecoder.create();
        const junk = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff);
        await decoder.decode([SILENT_FRAME.slice(), junk]);
        const after = await decoder.decode([SILENT_FRAME.slice(), SILENT_FRAME.slice()]);
        strictEqual(after.length, 2);
        decoder.close();
        deepStrictEqual(await decoder.decode([SILENT_FRAME.slice()]), []);
    });
});
