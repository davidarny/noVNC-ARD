/*
 * Replay of a real High Performance session through the receive path.
 *
 * Needs a fixture exported from a capture, which holds screen contents and
 * session keys and therefore lives outside this repository. The test is
 * skipped unless HP_REPLAY_FIXTURE names one:
 *
 *   HP_REPLAY_FIXTURE=/path/to/fixture.json node --test ard/tests/test.hp-replay.js
 *
 * The fixture also records what an independent implementation made of the
 * same datagrams; the two must agree.
 */

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { createContext } from '../hp/srtp.js';
import { VideoAssembler } from '../hp/rtp-video.js';
import { splitKeyBlock } from '../hp/negotiation.js';

const path = process.env.HP_REPLAY_FIXTURE;

function unhex(s) {
    return Uint8Array.from(Buffer.from(s, 'hex'));
}

function isRtcp(packet) {
    return packet[1] >= 192 && packet[1] <= 223;
}

describe('Replay of a captured session', { skip: !path && 'HP_REPLAY_FIXTURE not set' }, () => {
    it('decrypts every packet and rebuilds the same video stream', async () => {
        const fixture = JSON.parse(readFileSync(path, 'utf8'));
        const keys = [splitKeyBlock(unhex(fixture.keys.audio)), splitKeyBlock(unhex(fixture.keys.video))];

        // One context per channel and direction, as a live session has.
        const fromServer = [], toServer = [], reprotect = [];
        for (const k of keys) {
            fromServer.push(await createContext(k.fromServer.key, k.fromServer.salt));
            toServer.push(await createContext(k.toServer.key, k.toServer.salt));
            reprotect.push(await createContext(k.toServer.key, k.toServer.salt));
        }

        const hash = createHash('sha256');
        const stripes = [];
        let pictures = 0, firstDon = null, stalled = false;
        const assembler = new VideoAssembler({
            baseSsrc: fixture.server.videoBaseSsrc,
            stripes: fixture.server.stripes,
            onPicture(p) {
                if (firstDon === null) firstDon = p.don;
                hash.update(p.data);
                stripes.push(p.stripe);
                pictures++;
            },
            onStall() { stalled = true; },
        });

        let authFailures = 0, audioPackets = 0, serverRtcp = 0, clientRtcp = 0, reprotected = 0;
        for (const [ms, channel, direction, hex] of fixture.datagrams) {
            const packet = unhex(hex);
            if (direction === 's') {
                if (isRtcp(packet)) {
                    if (await fromServer[channel].unprotectRtcp(packet)) serverRtcp++;
                    else authFailures++;
                    continue;
                }
                const rtp = await fromServer[channel].unprotectRtp(packet);
                if (!rtp) { authFailures++; continue; }
                if (channel === 0) audioPackets++;
                else assembler.push(rtp, ms);
            } else {
                // What Apple's viewer sent: we must be able to read it, and
                // protecting the same plain packet must give the same bytes.
                const plain = await toServer[channel].unprotectRtcp(packet);
                if (!plain) { authFailures++; continue; }
                clientRtcp++;
                const again = await reprotect[channel].protectRtcp(plain);
                if (Buffer.compare(Buffer.from(again), Buffer.from(packet)) === 0) reprotected++;
            }
        }

        const expected = fixture.expected;
        strictEqual(authFailures, 0, 'authentication failures');
        strictEqual(stalled, false, 'assembler stalled');
        strictEqual(audioPackets, expected.audioPackets, 'audio packets');
        ok(serverRtcp > 0, 'server RTCP seen');
        ok(clientRtcp > 0, 'client RTCP seen');
        strictEqual(reprotected, clientRtcp, 'our SRTCP output equals the viewer\'s bytes');
        strictEqual(firstDon & 0xffff, expected.firstDon, 'first decoding order number');
        strictEqual(pictures, expected.pictures, 'pictures emitted');
        deepStrictEqual(stripes.slice(0, expected.stripeSequenceHead.length), expected.stripeSequenceHead);
        strictEqual(hash.digest('hex'), expected.videoSha256, 'video stream hash');
    });
});
