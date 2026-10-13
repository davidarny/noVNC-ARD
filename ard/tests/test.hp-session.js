/*
 * Unit tests for the High Performance session and the HEVC helpers.
 * A fake media socket, a fake sink and fake timers stand in for the browser;
 * the negotiation, SRTP, assembler and feedback code is the real thing.
 * All data here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-session.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import * as protobuf from '../hp/protobuf.js';
import * as plist from '../hp/plist.js';
import { deflate } from '../hp/zlib.js';
import { createContext } from '../hp/srtp.js';
import { splitKeyBlock } from '../hp/negotiation.js';
import { pictureAck } from '../hp/feedback.js';
import { HpSession, CHANNEL_AUDIO, CHANNEL_VIDEO } from '../hp/session.js';
import { codecFromAnnexB, splitAnnexB, DEFAULT_CODEC } from '../hp/hevc.js';

const SERVER_AUDIO_SSRC = 0x579aea87;
const SERVER_VIDEO_SSRC = 0x12671595;

function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function ascii(s) { return Array.from(s, c => c.charCodeAt(0)); }

// Let pending promises (WebCrypto, CompressionStream) run. They finish on
// other threads, so how many turns that takes depends on the machine's load.
async function settle(rounds = 60) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

// Wait for something that must happen.
async function until(condition, what = 'condition') {
    for (let i = 0; i < 20000 && !condition(); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    ok(condition(), 'timed out waiting for ' + what);
}

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.sent = [];
        this.closed = false;
        FakeWebSocket.last = this;
    }

    open() { this.onopen && this.onopen(); }
    send(data) { this.sent.push(new Uint8Array(data)); }
    close() { this.closed = true; }
    serverClose() { this.onclose && this.onclose({}); }

    deliver(channel, packet) {
        const msg = new Uint8Array(packet.length + 1);
        msg[0] = channel;
        msg.set(packet, 1);
        this.onmessage && this.onmessage({ data: msg.buffer });
    }
}

function message1() {
    const strings = ['Macmini9,1', 'unknown', 'unknown'];
    const body = [
        ...u16(2), 0, 0, 0, 1, 0, 0, 0, 0,
        ...strings.flatMap(s => u16(s.length + 1)),
        ...strings.flatMap(s => [...ascii(s), 0]),
        0, 0, 0, 0,
    ];
    return new Uint8Array([...u16(body.length), ...body]);
}

async function answerStream(fields) {
    return plist.encode({
        avcMediaStreamNegotiatorMediaBlob: await deflate(protobuf.encode(fields)),
        avcMediaStreamOptionRemoteEndpointInfo: protobuf.encode([{ field: 1, value: 0 }]),
    });
}

async function answer() {
    const audio = await answerStream([
        { field: 3, value: protobuf.encode([{ field: 1, value: SERVER_AUDIO_SSRC }]) },
    ]);
    const video = await answerStream([
        { field: 5, value: protobuf.encode([
            { field: 1, value: SERVER_VIDEO_SSRC },
            { field: 4, value: 3840 },
            { field: 5, value: 2160 },
            { field: 6, value: 4 },
        ]) },
    ]);
    const body = [
        ...u16(2), ...u16(2), 0, 0, 0, 1,
        ...u16(audio.length), ...u16(video.length), 0, 0, 0, 0, 0, 0,
        ...audio, ...video,
    ];
    return new Uint8Array([...u16(body.length), ...body]);
}

// The key blocks out of a 0x1c message.
function keysFromOffer(offer) {
    const view = new DataView(offer.buffer, offer.byteOffset);
    const audioSize = view.getUint16(10);
    return {
        audio: splitKeyBlock(offer.slice(36, 128)),
        video: splitKeyBlock(offer.slice(128 + audioSize, 220 + audioSize)),
    };
}

// A one-packet key picture for a stripe: parameter sets and an IDR slice
// aggregated, as the server starts each stream.
function keyPicturePacket({ stripe, seq, don, frame }) {
    const nals = [
        [0x40, 0x01, 0xaa], [0x42, 0x01, 0xbb], [0x44, 0x01, 0xcc],
        [stripe === 0 ? 0x28 : 0x02, 0x01, 0xd0 + stripe, 1, 2, 3],
    ];
    const payload = [0x60, 0x01, ...u16(don), ...nals.flatMap(n => [...u16(n.length), ...n])];
    return new Uint8Array([
        0x90, 0x80 | 100, ...u16(seq), ...u32(frame * 400), ...u32(SERVER_VIDEO_SSRC + stripe),
        0x93, 0x11, 0x00, 0x01, ...u16(1), ...u16(frame),
        ...payload,
    ]);
}

function audioPacket(seq) {
    return new Uint8Array([
        0x80, 101, ...u16(seq), ...u32(seq * 480), ...u32(SERVER_AUDIO_SSRC),
        0x00, 0x68, 0x34, 0x00,
    ]);
}

describe('HEVC helpers', () => {
    it('names a Range Extensions stream for WebCodecs from its VPS', () => {
        const vps = Buffer.from('40010c01ffff240800000300be08000003000099043024', 'hex');
        const data = new Uint8Array([0, 0, 0, 1, ...vps, 0, 0, 0, 1, 0x42, 0x01, 0x01]);
        strictEqual(codecFromAnnexB(data), 'hev1.4.10.H153.BE.08');
        strictEqual(DEFAULT_CODEC, 'hev1.4.10.H153.BE.08');
    });

    it('names a Main profile stream', () => {
        const vps = Buffer.from('40010c01ffff01600000030090000003000003005d959809', 'hex');
        strictEqual(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, ...vps])), 'hev1.1.6.L93.90');
    });

    it('returns null without a readable VPS', () => {
        strictEqual(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x42, 0x01, 0x01])), null);
        strictEqual(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x40, 0x01, 0x0c])), null);
        strictEqual(codecFromAnnexB(new Uint8Array(0)), null);
    });

    it('splits Annex B on three- and four-byte start codes', () => {
        const nals = splitAnnexB(new Uint8Array([0, 0, 0, 1, 9, 8, 0, 0, 1, 7, 0, 0, 0, 1, 6, 5, 4]));
        deepStrictEqual(nals.map(n => Array.from(n)), [[9, 8], [7], [6, 5, 4]]);
    });
});

describe('High Performance session', () => {
    let states, offers, sinks, session, ws;

    function create(extra = {}) {
        states = [];
        offers = [];
        sinks = [];
        session = new HpSession(Object.assign({
            mediaUrl: 'ws://relay.test/media',
            WebSocketImpl: FakeWebSocket,
            now: () => Date.now(),
            sendOffer: bytes => offers.push(bytes),
            onState: (state, reason) => states.push(reason ? state + ':' + reason : state),
            createSink: (opts) => {
                const sink = { opts, pictures: [], closed: false,
                               push(p) { this.pictures.push(p); }, close() { this.closed = true; } };
                sinks.push(sink);
                return sink;
            },
        }, extra));
        session.start();
        ws = FakeWebSocket.last;
        return session;
    }

    // Bring a session to 'waiting': media channel open, offer sent, answer in.
    async function negotiate(extra) {
        create(extra);
        ws.open();
        session.handleMessage1(message1());
        await until(() => offers.length === 1, 'the offer');
        session.handleAnswer(await answer());
        await until(() => session.state !== 'offering', 'the answer to be handled');
        return keysFromOffer(offers[0]);
    }

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    });

    afterEach(() => {
        if (session) session.close();
        mock.timers.reset();
    });

    it('opens the media channel at the URL it is given', () => {
        create();
        strictEqual(ws.url, 'ws://relay.test/media');
        strictEqual(session.state, 'idle');
    });

    it('sends the offer only when the server has asked and the media channel is open', async () => {
        create();
        session.handleMessage1(message1());
        await settle();
        strictEqual(offers.length, 0);
        ws.open();
        await until(() => offers.length === 1, 'the offer');
        strictEqual(offers[0][0], 0x1c);
        strictEqual(session.state, 'offering');

        // The other order.
        create();
        ws.open();
        await settle();
        strictEqual(offers.length, 0);
        session.handleMessage1(message1());
        await until(() => offers.length === 1, 'the offer');
    });

    it('sends one offer however often Message 1 arrives', async () => {
        create();
        ws.open();
        session.handleMessage1(message1());
        session.handleMessage1(message1());
        await settle();
        session.handleMessage1(message1());
        await settle();
        strictEqual(offers.length, 1);
    });

    it('fails when the media channel does not open', () => {
        create();
        mock.timers.tick(3000);
        deepStrictEqual(states, ['failed:media-connect']);
        ok(ws.closed);
    });

    it('fails when the server never opens the negotiation', () => {
        create();
        ws.open();
        mock.timers.tick(5000);
        deepStrictEqual(states, ['failed:no-message1']);
    });

    it('fails on a malformed Message 1', () => {
        create();
        ws.open();
        session.handleMessage1(new Uint8Array([0, 9, 1, 2]));
        deepStrictEqual(states, ['failed:bad-message1']);
    });

    it('fails when no answer follows the offer', async () => {
        create();
        ws.open();
        session.handleMessage1(message1());
        await until(() => offers.length === 1, 'the offer');
        mock.timers.tick(5000);
        deepStrictEqual(states, ['offering', 'failed:no-answer']);
    });

    it('fails on an answer it cannot read', async () => {
        create();
        ws.open();
        session.handleMessage1(message1());
        await settle();
        session.handleAnswer(new Uint8Array([0, 30, ...new Array(30).fill(7)]));
        await until(() => session.state === 'failed', 'the failure');
        deepStrictEqual(states, ['offering', 'failed:bad-answer']);
    });

    it('creates the sink from the answer and waits for a picture', async () => {
        await negotiate();
        deepStrictEqual(states, ['offering', 'waiting']);
        strictEqual(sinks.length, 1);
        strictEqual(sinks[0].opts.width, 3840);
        strictEqual(sinks[0].opts.height, 2160);
        strictEqual(sinks[0].opts.stripes, 4);
    });

    it('fails when no picture follows the answer, and closes the sink', async () => {
        await negotiate();
        mock.timers.tick(5000);
        deepStrictEqual(states, ['offering', 'waiting', 'failed:no-picture']);
        ok(sinks[0].closed);
    });

    it('decrypts video, hands pictures to the sink in order and acknowledges them', async () => {
        const keys = await negotiate();
        const server = await createContext(keys.video.fromServer.key, keys.video.fromServer.salt);
        const reader = await createContext(keys.video.toServer.key, keys.video.toServer.salt);

        // Stripe 1 arrives before the key picture of stripe 0.
        const p1 = await server.protectRtp(keyPicturePacket({ stripe: 1, seq: 500, don: 1001, frame: 7 }));
        const p0 = await server.protectRtp(keyPicturePacket({ stripe: 0, seq: 100, don: 1000, frame: 7 }));
        ws.deliver(CHANNEL_VIDEO, p1);
        await settle();
        strictEqual(sinks[0].pictures.length, 0);
        ws.deliver(CHANNEL_VIDEO, p0);
        await until(() => sinks[0].pictures.length === 2 && ws.sent.length === 2, 'two pictures and their acknowledgements');

        deepStrictEqual(sinks[0].pictures.map(p => [p.don & 0xffff, p.stripe, p.key]),
                        [[1000, 0, true], [1001, 1, false]]);
        strictEqual(session.stats.videoPackets, 2);
        strictEqual(session.stats.pictures, 2);
        strictEqual(session.stats.authFailures, 0);

        // Two acknowledgements went out, in order, readable with our key.
        const ourSsrc = session._secrets.videoSsrc;
        const acks = [];
        for (const msg of ws.sent) {
            strictEqual(msg[0], CHANNEL_VIDEO);
            const plain = await reader.unprotectRtcp(msg.subarray(1));
            ok(plain, 'our RTCP verifies');
            acks.push(Buffer.from(plain).toString('hex'));
        }
        deepStrictEqual(acks, [
            Buffer.from(pictureAck({ ssrc: ourSsrc, don: 1000 })).toString('hex'),
            Buffer.from(pictureAck({ ssrc: ourSsrc, don: 1001 })).toString('hex'),
        ]);

        // The sink reports its first frame: now streaming.
        sinks[0].opts.onFirstFrame();
        deepStrictEqual(states, ['offering', 'waiting', 'streaming']);
        mock.timers.tick(6000);
        strictEqual(session.state, 'streaming');
    });

    it('sends rate control every 50 ms and reports every second', async () => {
        const keys = await negotiate();
        const videoIn = await createContext(keys.video.fromServer.key, keys.video.fromServer.salt);
        const audioIn = await createContext(keys.audio.fromServer.key, keys.audio.fromServer.salt);
        const videoReader = await createContext(keys.video.toServer.key, keys.video.toServer.salt);
        const audioReader = await createContext(keys.audio.toServer.key, keys.audio.toServer.salt);

        ws.deliver(CHANNEL_VIDEO, await videoIn.protectRtp(keyPicturePacket({ stripe: 0, seq: 100, don: 5, frame: 1 })));
        ws.deliver(CHANNEL_AUDIO, await audioIn.protectRtp(audioPacket(4242)));
        await until(() => session.stats.audioPackets === 1 && session.stats.pictures === 1 && ws.sent.length === 1, 'the first packets');
        sinks[0].opts.onFirstFrame();
        strictEqual(session.stats.audioPackets, 1);
        ws.sent.length = 0;

        for (let i = 0; i < 20; i++) {
            mock.timers.tick(50);
            await settle(4);
        }
        await until(() => ws.sent.length === 22, 'twenty rate reports and two receiver reports');

        const kinds = { rctl: 0, videoReport: 0, audioReport: 0 };
        for (const msg of ws.sent) {
            const reader = msg[0] === CHANNEL_VIDEO ? videoReader : audioReader;
            const plain = await reader.unprotectRtcp(msg.subarray(1));
            ok(plain, 'our RTCP verifies');
            if (plain[1] === 204 && String.fromCharCode(...plain.subarray(8, 12)) === 'RCTL') kinds.rctl++;
            else if (plain[1] === 201 && msg[0] === CHANNEL_VIDEO) {
                kinds.videoReport++;
                strictEqual(new DataView(plain.buffer, plain.byteOffset).getUint32(8), SERVER_VIDEO_SSRC);
                strictEqual(new DataView(plain.buffer, plain.byteOffset).getUint32(16), 100);
            } else if (plain[1] === 201) {
                kinds.audioReport++;
                strictEqual(new DataView(plain.buffer, plain.byteOffset).getUint32(8), SERVER_AUDIO_SSRC);
                strictEqual(new DataView(plain.buffer, plain.byteOffset).getUint32(16), 4242);
            }
        }
        deepStrictEqual(kinds, { rctl: 20, videoReport: 1, audioReport: 1 });
    });

    it('sends only the feedback it is told to', async () => {
        const keys = await negotiate({ feedback: { reports: false, acks: false, rateControl: false } });
        const videoIn = await createContext(keys.video.fromServer.key, keys.video.fromServer.salt);
        ws.deliver(CHANNEL_VIDEO, await videoIn.protectRtp(keyPicturePacket({ stripe: 0, seq: 1, don: 9, frame: 1 })));
        await settle();
        sinks[0].opts.onFirstFrame();
        mock.timers.tick(1200);
        await settle();
        strictEqual(sinks[0].pictures.length, 1);
        strictEqual(ws.sent.length, 0);
    });

    it('counts and drops datagrams that do not verify, and survives junk', async () => {
        const keys = await negotiate();
        const videoIn = await createContext(keys.video.fromServer.key, keys.video.fromServer.salt);
        const good = await videoIn.protectRtp(keyPicturePacket({ stripe: 0, seq: 1, don: 9, frame: 1 }));
        const bad = good.slice();
        bad[20] ^= 0x01;

        ws.deliver(CHANNEL_VIDEO, bad);
        ws.deliver(CHANNEL_VIDEO, new Uint8Array([1, 2, 3]));
        ws.deliver(7, good);
        ws.onmessage({ data: new ArrayBuffer(0) });
        await until(() => session.stats.authFailures === 1, 'the rejected datagram');
        await settle();
        strictEqual(sinks[0].pictures.length, 0);
        strictEqual(session.state, 'waiting');

        ws.deliver(CHANNEL_VIDEO, good);
        await until(() => sinks[0].pictures.length === 1, 'the picture');
    });

    it('fails once when the media channel closes, and stops its timers', async () => {
        await negotiate();
        sinks[0].opts.onFirstFrame();
        ws.sent.length = 0;
        ws.serverClose();
        deepStrictEqual(states, ['offering', 'waiting', 'streaming', 'failed:media-closed']);
        ok(sinks[0].closed);
        mock.timers.tick(10000);
        await settle();
        strictEqual(ws.sent.length, 0);
        strictEqual(states.filter(s => s.startsWith('failed')).length, 1);
    });

    it('fails when the sink reports a decoder error', async () => {
        await negotiate();
        sinks[0].opts.onError('boom');
        deepStrictEqual(states, ['offering', 'waiting', 'failed:decoder']);
        strictEqual(session.failure, 'decoder: boom');
    });

    it('fails when a picture never arrives', async () => {
        const keys = await negotiate();
        const videoIn = await createContext(keys.video.fromServer.key, keys.video.fromServer.salt);
        ws.deliver(CHANNEL_VIDEO, await videoIn.protectRtp(keyPicturePacket({ stripe: 0, seq: 1, don: 10, frame: 1 })));
        // don 11 is lost; 12 arrives and waits.
        ws.deliver(CHANNEL_VIDEO, await videoIn.protectRtp(keyPicturePacket({ stripe: 2, seq: 9, don: 12, frame: 1 })));
        await until(() => session.stats.videoPackets === 2, 'both packets');
        sinks[0].opts.onFirstFrame();
        for (let i = 0; i < 8 && session.state !== 'failed'; i++) {
            mock.timers.tick(50);
            await settle(2);
        }
        strictEqual(states[states.length - 1], 'failed:stalled');
    });

    it('hands audio packets to the audio pipeline once it is ready, and closes it', async () => {
        const audio = { packets: [], closed: false, push(rtp) { this.packets.push(rtp.seq); }, close() { this.closed = true; } };
        const keys = await negotiate({ createAudio: async () => audio });
        const audioIn = await createContext(keys.audio.fromServer.key, keys.audio.fromServer.salt);
        await settle();
        ws.deliver(CHANNEL_AUDIO, await audioIn.protectRtp(audioPacket(7)));
        ws.deliver(CHANNEL_AUDIO, await audioIn.protectRtp(audioPacket(8)));
        await until(() => audio.packets.length === 2, 'two audio packets');
        deepStrictEqual(audio.packets.sort(), [7, 8]);
        session.close();
        ok(audio.closed);
    });

    it('mutes the audio pipeline, whether asked before or after it is ready', async () => {
        const audio = { muted: [], push() {}, setMuted(m) { this.muted.push(m); }, close() {} };
        await negotiate({ createAudio: async () => audio, audioMuted: true });
        await until(() => session.audioReady, 'audio');
        deepStrictEqual(audio.muted, [true]);
        session.setAudioMuted(false);
        session.setAudioMuted(true);
        deepStrictEqual(audio.muted, [true, false, true]);
        deepStrictEqual(session.video, { ssrc: SERVER_VIDEO_SSRC, width: 3840, height: 2160, stripes: 4 });
    });

    it('carries on without sound when the audio pipeline cannot be made', async () => {
        const keys = await negotiate({ createAudio: async () => { throw new Error('no AudioWorklet'); } });
        const audioIn = await createContext(keys.audio.fromServer.key, keys.audio.fromServer.salt);
        await settle();
        ws.deliver(CHANNEL_AUDIO, await audioIn.protectRtp(audioPacket(7)));
        await until(() => session.stats.audioPackets === 1, 'the audio packet');
        strictEqual(session.state, 'waiting');
    });

    it('closes an audio pipeline that becomes ready after the session has ended', async () => {
        let ready;
        const audio = { closed: false, push() {}, close() { this.closed = true; } };
        await negotiate({ createAudio: () => new Promise((resolve) => { ready = resolve; }) });
        await until(() => typeof ready === 'function', 'audio creation to start');
        session.close();
        ready(audio);
        await settle();
        ok(audio.closed);
    });

    it('closes quietly', async () => {
        await negotiate();
        session.close();
        deepStrictEqual(states, ['offering', 'waiting', 'closed']);
        ok(sinks[0].closed);
        ok(ws.closed);
        mock.timers.tick(10000);
        strictEqual(states.length, 3);
    });
});
