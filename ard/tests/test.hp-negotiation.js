/*
 * Unit tests for the High Performance mode negotiation messages.
 * All data here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-negotiation.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws, rejects } from 'node:assert';

import * as protobuf from '../hp/protobuf.js';
import * as plist from '../hp/plist.js';
import { deflate, inflate } from '../hp/zlib.js';
import {
    parseMessage1, generateSecrets, splitKeyBlock, buildOffer, parseAnswer,
    ntpFromUnixMs, KEY_BLOCK_LENGTH,
} from '../hp/negotiation.js';

function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function ascii(s) { return Array.from(s, c => c.charCodeAt(0)); }

// Message 1 as the server sends it: three zero-terminated strings.
function message1(strings) {
    const body = [
        ...u16(2), 0, 0, 0, 1, 0, 0, 0, 0,
        ...strings.flatMap(s => u16(s.length + 1)),
        ...strings.flatMap(s => [...ascii(s), 0]),
        0, 0, 0, 0,
    ];
    return new Uint8Array([...u16(body.length), ...body]);
}

function fixedSecrets() {
    return {
        sessionId: Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i),
        audioKeys: Uint8Array.from({ length: 92 }, (_, i) => i),
        videoKeys: Uint8Array.from({ length: 92 }, (_, i) => 0xff - i),
        audioSsrc: 0x11223344,
        videoSsrc: 0xf1e2d3c4,
        callIds: ['11111111-2222-4333-8444-555555555555', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'],
    };
}

async function answerStream(blobFields) {
    return plist.encode({
        avcMediaStreamNegotiatorMediaBlob: await deflate(protobuf.encode(blobFields)),
        avcMediaStreamOptionRemoteEndpointInfo: protobuf.encode([
            { field: 1, value: 0 }, { field: 3, value: 'Test1,1' },
        ]),
    });
}

function answerPayload(audio, video) {
    const body = [
        ...u16(2), ...u16(2), 0, 0, 0, 1,
        ...u16(audio.length), ...u16(video.length), 0, 0, 0, 0, 0, 0,
        ...audio, ...video,
    ];
    return new Uint8Array([...u16(body.length), ...body]);
}

function audioBlob(ssrc) {
    return [
        { field: 1, value: 1 },
        { field: 3, value: protobuf.encode([{ field: 1, value: ssrc }, { field: 6, value: 1 }]) },
        { field: 6, value: 'Viceroy 1.7.0' },
    ];
}

function videoBlob(fields) {
    return [
        { field: 1, value: 1 },
        { field: 5, value: protobuf.encode(fields) },
    ];
}

describe('Message 1', () => {
    it('reads the model identifier and the other strings', () => {
        const m = parseMessage1(message1(['Macmini9,1', 'unknown', 'unknown']));
        strictEqual(m.model, 'Macmini9,1');
        deepStrictEqual(m.strings, ['Macmini9,1', 'unknown', 'unknown']);
    });

    it('rejects a truncated message', () => {
        const full = message1(['Mac16,10', 'unknown', 'unknown']);
        throws(() => parseMessage1(full.subarray(0, full.length - 5)));
        throws(() => parseMessage1(new Uint8Array([0])));
        throws(() => parseMessage1(new Uint8Array([0, 4, 0, 2, 0, 0])));
    });

    it('rejects string lengths that run past the end', () => {
        const bad = message1(['Mac16,10', 'unknown', 'unknown']);
        bad[2 + 10] = 0x7f;
        throws(() => parseMessage1(bad));
    });
});

describe('Secrets', () => {
    it('generates fresh keys, ids and SSRCs', () => {
        const a = generateSecrets();
        const b = generateSecrets();
        strictEqual(a.sessionId.length, 16);
        strictEqual(a.sessionId[6] >> 4, 4);
        strictEqual(a.audioKeys.length, KEY_BLOCK_LENGTH);
        strictEqual(a.videoKeys.length, KEY_BLOCK_LENGTH);
        ok(a.audioSsrc > 0 && a.audioSsrc <= 0xffffffff);
        ok(a.videoSsrc > 0 && a.videoSsrc <= 0xffffffff);
        strictEqual(a.callIds.length, 2);
        for (const id of a.callIds) {
            ok(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(id), id);
        }
        ok(a.callIds[0] !== a.callIds[1]);
        ok(Buffer.compare(Buffer.from(a.audioKeys), Buffer.from(b.audioKeys)) !== 0);
        ok(Buffer.compare(Buffer.from(a.audioKeys), Buffer.from(a.videoKeys)) !== 0);
    });

    it('splits a key block into the two directions', () => {
        const block = Uint8Array.from({ length: 92 }, (_, i) => i);
        const k = splitKeyBlock(block);
        strictEqual(k.toServer.key.length, 32);
        strictEqual(k.toServer.salt.length, 14);
        strictEqual(k.toServer.key[0], 0);
        strictEqual(k.toServer.salt[0], 32);
        strictEqual(k.fromServer.key[0], 46);
        strictEqual(k.fromServer.salt[0], 78);
        strictEqual(k.fromServer.salt[13], 91);
        throws(() => splitKeyBlock(new Uint8Array(91)));
    });

    it('converts Unix time to the NTP form used in offers', () => {
        strictEqual(ntpFromUnixMs(0), 2208988800n << 32n);
        strictEqual(ntpFromUnixMs(1500), ((2208988800n + 1n) << 32n) | 0x80000000n);
    });
});

describe('Offer (message 0x1c)', () => {
    const ntpTime = 0xee78011e53bbb000n;

    it('has the header, lengths and key blocks where the spec puts them', async () => {
        const s = fixedSecrets();
        const msg = await buildOffer(s, { ntpTime });
        const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);

        strictEqual(msg[0], 0x1c);
        strictEqual(msg[1], 0);
        strictEqual(view.getUint16(2), msg.length - 4);
        strictEqual(view.getUint16(4), 3);
        strictEqual(view.getUint32(6), 0x0000000d);
        const audioSize = view.getUint16(10);
        const videoSize = view.getUint16(12);
        deepStrictEqual([view.getUint16(14), view.getUint16(16), view.getUint16(18)], [0, 0, 0]);
        deepStrictEqual(msg.subarray(20, 36), s.sessionId);
        strictEqual(msg.length, 36 + 92 + audioSize + 92 + videoSize);
        deepStrictEqual(msg.subarray(36, 128), s.audioKeys);
        deepStrictEqual(msg.subarray(128 + audioSize, 220 + audioSize), s.videoKeys);
    });

    it('carries an audio offer with our SSRC, time and call id', async () => {
        const s = fixedSecrets();
        const msg = await buildOffer(s, { ntpTime });
        const audioSize = new DataView(msg.buffer).getUint16(10);
        const dict = plist.decode(msg.subarray(128, 128 + audioSize));

        deepStrictEqual(Object.keys(dict).sort(), [
            'avcMediaStreamNegotiatorMediaBlob',
            'avcMediaStreamNegotiatorMode',
            'avcMediaStreamOptionCallID',
            'avcMediaStreamOptionRemoteEndpointInfo',
        ]);
        strictEqual(dict.avcMediaStreamNegotiatorMode, 8);
        strictEqual(dict.avcMediaStreamOptionCallID, s.callIds[0]);

        const endpoint = protobuf.decode(dict.avcMediaStreamOptionRemoteEndpointInfo);
        strictEqual(new TextDecoder().decode(protobuf.get(endpoint, 3)), 'Mac13,1');

        const blob = protobuf.decode(await inflate(dict.avcMediaStreamNegotiatorMediaBlob));
        const audio = protobuf.decode(protobuf.get(blob, 3));
        strictEqual(protobuf.get(audio, 1), 0x11223344);
        strictEqual(protobuf.get(audio, 4), 7807);
        strictEqual(protobuf.get(blob, 5), undefined);
        strictEqual(new TextDecoder().decode(protobuf.get(blob, 6)), 'Viceroy 1.7.0');
        strictEqual(protobuf.getAll(blob, 9).length, 10);
        strictEqual(protobuf.get(blob, 13), ntpTime);
        strictEqual(protobuf.get(blob, 18), 1);
    });

    it('carries a video offer listing H.264 then HEVC', async () => {
        const s = fixedSecrets();
        const msg = await buildOffer(s, { ntpTime, endpoint: { model: 'X1,1', version: '1.2', build: '9Z9' } });
        const view = new DataView(msg.buffer);
        const audioSize = view.getUint16(10);
        const videoSize = view.getUint16(12);
        const start = 220 + audioSize;
        const dict = plist.decode(msg.subarray(start, start + videoSize));

        strictEqual(dict.avcMediaStreamNegotiatorMode, 7);
        strictEqual(dict.avcMediaStreamOptionCallID, s.callIds[1]);
        const endpoint = protobuf.decode(dict.avcMediaStreamOptionRemoteEndpointInfo);
        strictEqual(new TextDecoder().decode(protobuf.get(endpoint, 3)), 'X1,1');
        strictEqual(new TextDecoder().decode(protobuf.get(endpoint, 5)), '9Z9');

        const blob = protobuf.decode(await inflate(dict.avcMediaStreamNegotiatorMediaBlob));
        strictEqual(protobuf.get(blob, 3), undefined);
        const video = protobuf.decode(protobuf.get(blob, 5));
        strictEqual(protobuf.get(video, 1), 0xf1e2d3c4);
        strictEqual(protobuf.get(video, 6), 4);
        const entries = protobuf.getAll(video, 3).map(e => protobuf.decode(e));
        deepStrictEqual(entries.map(e => protobuf.get(e, 1)), [123, 100]);
        deepStrictEqual(entries.map(e => protobuf.getAll(e, 2).length), [4, 2]);
        ok(new TextDecoder().decode(protobuf.get(entries[1], 3)).includes('POSE:4'));
        strictEqual(protobuf.get(entries[1], 4), 14);
    });

    async function offeredPayloadTypes(options) {
        const msg = await buildOffer(fixedSecrets(), { ntpTime, ...options });
        const view = new DataView(msg.buffer);
        const start = 220 + view.getUint16(10);
        const dict = plist.decode(msg.subarray(start, start + view.getUint16(12)));
        const blob = protobuf.decode(await inflate(dict.avcMediaStreamNegotiatorMediaBlob));
        const video = protobuf.decode(protobuf.get(blob, 5));
        return protobuf.getAll(video, 3).map(e => protobuf.get(protobuf.decode(e), 1));
    }

    it('lists only the video codecs it is told to', async () => {
        deepStrictEqual(await offeredPayloadTypes({ codecs: ['h264'] }), [123]);
        deepStrictEqual(await offeredPayloadTypes({ codecs: ['hevc'] }), [100]);
        // whatever order they are named in, the offer keeps the viewer's order
        deepStrictEqual(await offeredPayloadTypes({ codecs: ['hevc', 'h264'] }), [123, 100]);
        deepStrictEqual(await offeredPayloadTypes({ codecs: undefined }), [123, 100]);
    });

    it('refuses an empty or unknown list of video codecs', async () => {
        await rejects(buildOffer(fixedSecrets(), { ntpTime, codecs: [] }));
        await rejects(buildOffer(fixedSecrets(), { ntpTime, codecs: ['vp9'] }));
        await rejects(buildOffer(fixedSecrets(), { ntpTime, codecs: ['hevc', 'av1'] }));
    });

    it('refuses malformed secrets', async () => {
        const s = fixedSecrets();
        s.audioKeys = new Uint8Array(10);
        await rejects(buildOffer(s, { ntpTime }));
    });
});

describe('Answer', () => {
    const videoFields = [
        { field: 1, value: 0x12671595 },
        { field: 4, value: 3840 },
        { field: 5, value: 2160 },
        { field: 6, value: 4 },
    ];

    it('yields the server SSRCs and the picture size', async () => {
        const payload = answerPayload(
            await answerStream(audioBlob(0x579aea87)),
            await answerStream(videoBlob(videoFields)));
        const a = await parseAnswer(payload);
        strictEqual(a.audio.ssrc, 0x579aea87);
        deepStrictEqual(a.video, { ssrc: 0x12671595, width: 3840, height: 2160, stripes: 4 });
    });

    it('handles an SSRC with the top bit set', async () => {
        const payload = answerPayload(
            await answerStream(audioBlob(0xa656a732)),
            await answerStream(videoBlob([{ field: 1, value: 0x9d81196f }, ...videoFields.slice(1)])));
        const a = await parseAnswer(payload);
        strictEqual(a.audio.ssrc, 0xa656a732);
        strictEqual(a.video.ssrc, 0x9d81196f);
    });

    it('rejects truncated, empty and incomplete answers', async () => {
        const audio = await answerStream(audioBlob(1));
        const video = await answerStream(videoBlob(videoFields));
        const good = answerPayload(audio, video);

        await rejects(parseAnswer(good.subarray(0, good.length - 20)));
        await rejects(parseAnswer(new Uint8Array([0])));
        await rejects(parseAnswer(answerPayload([], video)));

        const noSize = await answerStream(videoBlob(videoFields.slice(0, 1)));
        await rejects(parseAnswer(answerPayload(audio, noSize)));

        const garbage = Uint8Array.from({ length: 64 }, (_, i) => i * 7);
        await rejects(parseAnswer(answerPayload(audio, garbage)));
    });
});
