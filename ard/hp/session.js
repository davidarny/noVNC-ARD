/*
 * High Performance mode — one session.
 *
 * Ties the pieces together (ARD protocol spec, Section 14):
 *
 *   idle ──Message 1──► offering ──answer──► waiting ──first frame──► streaming
 *     └──────────────── any failure ─────────────────────────────────► failed
 *
 * The RFB layer hands in Message 1 and the answer as they arrive on TCP and
 * sends the offer this session builds. Media travels on a second WebSocket
 * to the relay: each message is one channel byte (0 audio, 1 video) and one
 * UDP datagram.
 */

import { parseMessage1, generateSecrets, buildOffer, parseAnswer, splitKeyBlock } from './negotiation.js';
import { createContext } from './srtp.js';
import { VideoAssembler } from './rtp-video.js';
import { receiverReport, pictureAck, rateControl } from './feedback.js';
import { extendSeq } from './seq.js';
import { PAYLOAD_TYPE_HEVC } from './offer-template.js';

// WebSocket subprotocol a relay's media endpoint answers to.
export const MEDIA_SUBPROTOCOL = 'ard-media';

export const CHANNEL_AUDIO = 0;
export const CHANNEL_VIDEO = 1;

const MEDIA_CONNECT_MS = 3000;
const MESSAGE1_MS = 5000;
const ENCRYPTION_MS = 5000;
const ANSWER_MS = 5000;
const FIRST_FRAME_MS = 5000;
const REPORT_MS = 1000;
const RATE_CONTROL_MS = 50;
const IDLE_BANDWIDTH_KBIT = 60000;

// Nothing can be dropped from the stream without spoiling what follows, so
// a viewer that cannot keep up falls further and further behind. Half a
// second of pictures waiting for the decoder, or this many packets waiting
// to be decrypted, is normal for a moment when a stream starts; lasting
// this long it is a machine that is too slow, and the session ends.
const OVERLOAD_PICTURES = 120;
const OVERLOAD_PACKETS = 2000;
const OVERLOAD_MS = 2000;

// The server sends sound a hundred times a second whether or not there is
// any, so a few seconds without a single packet means it has stopped
// sending, which a server may do without a word on the RFB connection. The
// picture would stay as it was, looking alive.
const MEDIA_SILENCE_MS = 3000;

function isRtcp(packet) {
    return packet.length > 1 && packet[1] >= 192 && packet[1] <= 223;
}

// Highest sequence number seen on one RTP stream, extended past 16 bits.
class SeqTracker {
    constructor() {
        this.highest = null;
    }

    update(seq) {
        if (this.highest === null) {
            this.highest = seq;
            return;
        }
        this.highest = Math.max(this.highest, extendSeq(this.highest, seq));
    }
}

export class HpSession {
    /*
     * mediaUrl:        WebSocket URL of the relay's media endpoint
     * sendOffer(bytes): send the 0x1c message on the RFB connection
     * holdOffer:       true if the RFB connection is still to be encrypted. The offer
     *                  carries the media keys, so it waits for releaseOffer().
     * createSink({ width, height, stripes, onFirstFrame, onError }): → { push(picture), close() }
     *                  and optionally `backlog`, the pictures it has not decoded yet
     * createAudio():   optional; resolves to { push(rtp), close() } that plays the sound.
     *                  Without it, or if it fails, audio packets are counted and dropped.
     * onState(state, reason): called on every state change
     * feedback:        { reports, acks, rateControl } — which RTCP to send
     * endpoint:        how the viewer describes itself in the offer
     */
    constructor({ mediaUrl, sendOffer, holdOffer, createSink, createAudio, audioMuted, onState,
                  feedback, endpoint, WebSocketImpl, now, log }) {
        this._mediaUrl = mediaUrl;
        this._sendOffer = sendOffer;
        this._offerHeld = !!holdOffer;
        this._createSink = createSink;
        this._createAudio = createAudio;
        this._audio = null;
        this._audioMuted = !!audioMuted;
        this._onState = onState || (() => {});
        this._feedback = Object.assign({ reports: true, acks: true, rateControl: true }, feedback);
        this._endpoint = endpoint;
        this._WebSocket = WebSocketImpl || globalThis.WebSocket;
        this._now = now || (() => performance.now());
        this._log = log || (() => {});

        this.state = 'idle';
        this.failure = null;
        this.stats = {
            videoPackets: 0, videoBytes: 0, audioPackets: 0, rtcpPackets: 0,
            authFailures: 0, pictures: 0, keyPictures: 0, sent: 0,
        };

        this._ws = null;
        this._wsOpen = false;
        this._message1 = null;
        this._secrets = null;
        this._answer = null;
        this._ctx = null;           // { audioIn, audioOut, videoIn, videoOut }
        this._assembler = null;
        this._sink = null;
        this._timers = new Set();
        this._intervals = new Set();
        this._sendChain = [Promise.resolve(), Promise.resolve()];
        this._audioSeq = new SeqTracker();
        this._videoSeq = new SeqTracker();
        this._lastVideoPacketAt = null;
        this._lastMediaAt = null;                // last packet of either stream that verified
        this._lastSenderReport = [null, null];   // per channel: { middle, at }
        this._decrypting = 0;                    // packets handed to SRTP and not back yet
        this._overloadedSince = null;
    }

    // The picture size and stripe count from the server's answer.
    get video() {
        return this._answer ? this._answer.video : null;
    }

    get audioReady() {
        return !!this._audio;
    }

    // Silence the sound without stopping it.
    setAudioMuted(muted) {
        this._audioMuted = !!muted;
        if (this._audio && this._audio.setMuted) this._audio.setMuted(this._audioMuted);
    }

    // ----- lifecycle -----

    start() {
        if (this.state !== 'idle' || this._ws) return;
        let ws;
        try {
            ws = new this._WebSocket(this._mediaUrl, MEDIA_SUBPROTOCOL);
        } catch (e) {
            this._fail('media-connect', e.message);
            return;
        }
        ws.binaryType = 'arraybuffer';
        this._ws = ws;
        ws.onopen = () => {
            // A plain TCP proxy accepts any path and would hand us the
            // server's RFB greeting here. Only a relay's media endpoint
            // agrees to the subprotocol.
            if (ws.protocol !== MEDIA_SUBPROTOCOL) {
                this._fail('media-connect', 'not a media channel');
                return;
            }
            this._wsOpen = true;
            this._log('media channel open');
            this._maybeOffer();
        };
        ws.onmessage = ev => this._onMedia(ev.data);
        ws.onclose = () => {
            this._wsOpen = false;
            if (this.state !== 'closed' && this.state !== 'failed') {
                this._fail(this.state === 'idle' && !this._message1 ? 'media-connect' : 'media-closed');
            }
        };
        ws.onerror = () => {};   // a close event follows
        this._timeout(MEDIA_CONNECT_MS, () => {
            if (!this._wsOpen) this._fail('media-connect', 'timeout');
        });
        this._timeout(MESSAGE1_MS, () => {
            if (!this._message1) this._fail('no-message1');
        });
    }

    close() {
        if (this.state === 'closed') return;
        this._teardown();
        this._setState('closed');
    }

    _teardown() {
        for (const t of this._timers) clearTimeout(t);
        for (const t of this._intervals) clearInterval(t);
        this._timers.clear();
        this._intervals.clear();
        if (this._sink) {
            this._sink.close();
            this._sink = null;
        }
        if (this._audio) {
            this._audio.close();
            this._audio = null;
        }
        this._torn = true;
        if (this._ws) {
            const ws = this._ws;
            this._ws = null;
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(); } catch (e) { /* already closed */ }
        }
        this._wsOpen = false;
    }

    _fail(reason, detail) {
        if (this.state === 'failed' || this.state === 'closed') return;
        this.failure = detail ? reason + ': ' + detail : reason;
        this._log('failed: ' + this.failure + ' ' + JSON.stringify(this.stats));
        this._teardown();
        this._setState('failed', reason);
    }

    _setState(state, reason) {
        if (this.state === state) return;
        this.state = state;
        this._onState(state, reason);
    }

    _timeout(ms, fn) {
        const t = setTimeout(() => {
            this._timers.delete(t);
            fn();
        }, ms);
        this._timers.add(t);
        return t;
    }

    _interval(ms, fn) {
        const t = setInterval(fn, ms);
        this._intervals.add(t);
        return t;
    }

    // ----- negotiation -----

    // The payload of the rectangle with encoding 1110.
    handleMessage1(payload) {
        if (this.state !== 'idle' || this._message1) return;
        try {
            this._message1 = parseMessage1(payload);
        } catch (e) {
            this._fail('bad-message1', e.message);
            return;
        }
        this._log('server offers High Performance (' + this._message1.model + ')');
        if (this._offerHeld) {
            this._timeout(ENCRYPTION_MS, () => {
                if (this._offerHeld) this._fail('no-encryption');
            });
        }
        this._maybeOffer();
    }

    // The RFB connection is encrypted now: the offer may be sent on it.
    releaseOffer() {
        if (!this._offerHeld) return;
        this._offerHeld = false;
        this._maybeOffer();
    }

    // The offer goes out once the server has asked and the media channel is
    // up: the server starts sending as soon as it has answered. It holds
    // the keys of the media, so it also waits for a connection that is
    // about to be encrypted.
    _maybeOffer() {
        if (this.state !== 'idle' || !this._message1 || !this._wsOpen || this._offerHeld) return;
        this._setState('offering');
        this._secrets = generateSecrets();
        buildOffer(this._secrets, { endpoint: this._endpoint }).then((offer) => {
            if (this.state !== 'offering') return;
            this._sendOffer(offer);
            this._timeout(ANSWER_MS, () => {
                if (this.state === 'offering') this._fail('no-answer');
            });
        }, e => this._fail('offer', e.message));
    }

    // The payload of the rectangle with encoding 1010.
    handleAnswer(payload) {
        if (this.state !== 'offering' || this._answering) return;
        this._answering = true;
        this._startMedia(payload).catch(e => this._fail('bad-answer', e.message));
    }

    async _startMedia(payload) {
        const answer = await parseAnswer(payload);
        const audio = splitKeyBlock(this._secrets.audioKeys);
        const video = splitKeyBlock(this._secrets.videoKeys);
        const ctx = {
            audioIn: await createContext(audio.fromServer.key, audio.fromServer.salt),
            audioOut: await createContext(audio.toServer.key, audio.toServer.salt),
            videoIn: await createContext(video.fromServer.key, video.fromServer.salt),
            videoOut: await createContext(video.toServer.key, video.toServer.salt),
        };
        if (this.state !== 'offering') return;

        this._answer = answer;
        this._ctx = ctx;
        this._assembler = new VideoAssembler({
            baseSsrc: answer.video.ssrc,
            stripes: answer.video.stripes,
            onPicture: p => this._onPicture(p),
            onStall: s => this._fail('stalled', 'waiting for picture ' + s.expectedDon),
        });
        this._sink = this._createSink({
            width: answer.video.width,
            height: answer.video.height,
            stripes: answer.video.stripes,
            onFirstFrame: () => {
                if (this.state === 'waiting') this._setState('streaming');
            },
            onError: reason => this._fail('decoder', reason),
        });
        this._log('answer: ' + answer.video.width + 'x' + answer.video.height +
                  ', ' + answer.video.stripes + ' stripes');
        this._setState('waiting');

        // Sound is a bonus: the picture does not wait for it, and its
        // failure is not the session's.
        if (this._createAudio) {
            Promise.resolve().then(() => this._createAudio()).then((audio) => {
                if (this._torn) audio.close();
                else {
                    this._audio = audio;
                    if (audio.setMuted) audio.setMuted(this._audioMuted);
                    this._log('audio ready');
                }
            }, e => this._log('no audio: ' + (e && e.message ? e.message : e)));
        }

        // Datagrams that arrived while the keys were being derived.
        const early = this._early || [];
        this._early = null;
        for (const data of early) this._onMedia(data);

        this._timeout(FIRST_FRAME_MS, () => {
            if (this.state === 'waiting') this._fail('no-picture');
        });
        this._interval(RATE_CONTROL_MS, () => this._tick());
        this._interval(REPORT_MS, () => this._sendReports());
    }

    // ----- media in -----

    _onMedia(data) {
        if (this.state === 'failed' || this.state === 'closed') return;
        if (!this._ctx) {
            // The server may start before our keys are ready.
            if (this.state === 'offering') {
                (this._early = this._early || []).push(data);
                if (this._early.length > 4096) this._early.shift();
            }
            return;
        }
        const bytes = new Uint8Array(data);
        if (bytes.length < 13) return;
        const channel = bytes[0];
        const packet = bytes.subarray(1);
        if (channel !== CHANNEL_AUDIO && channel !== CHANNEL_VIDEO) return;
        const now = this._now();
        const ctx = channel === CHANNEL_VIDEO ? this._ctx.videoIn : this._ctx.audioIn;

        if (isRtcp(packet)) {
            ctx.unprotectRtcp(packet).then((plain) => {
                if (!plain) { this.stats.authFailures++; return; }
                this.stats.rtcpPackets++;
                // Sender report: remember its NTP time for our next report.
                if (plain[1] === 200 && plain.length >= 16) {
                    const middle = ((plain[10] << 24) | (plain[11] << 16) | (plain[12] << 8) | plain[13]) >>> 0;
                    this._lastSenderReport[channel] = { middle, at: now };
                }
            }, () => { this.stats.authFailures++; });
            return;
        }

        this._decrypting++;
        ctx.unprotectRtp(packet).then((rtp) => {
            this._decrypting--;
            if (!rtp) { this.stats.authFailures++; return; }
            if (this.state === 'failed' || this.state === 'closed') return;
            this._lastMediaAt = this._now();
            if (channel === CHANNEL_AUDIO) {
                this.stats.audioPackets++;
                this._audioSeq.update(rtp.seq);
                if (this._audio) this._audio.push(rtp);
                return;
            }
            if (rtp.payloadType !== PAYLOAD_TYPE_HEVC) {
                // The offer lists a second video format because Apple's does;
                // this viewer reads HEVC only.
                this._fail('unsupported-video', 'payload type ' + rtp.payloadType);
                return;
            }
            this.stats.videoPackets++;
            this.stats.videoBytes += rtp.payload.length;
            this._lastVideoPacketAt = this._now();
            if (rtp.ssrc === this._answer.video.ssrc) this._videoSeq.update(rtp.seq);
            this._assembler.push(rtp, this._now());
        }, () => {
            this._decrypting--;
            this.stats.authFailures++;
        });
    }

    _onPicture(picture) {
        this.stats.pictures++;
        if (picture.key) this.stats.keyPictures++;
        if (this._sink) this._sink.push(picture);
        if (this._feedback.acks) {
            this._sendRtcp(CHANNEL_VIDEO, pictureAck({
                ssrc: this._secrets.videoSsrc,
                don: picture.don & 0xffff,
            }));
        }
    }

    // ----- media out -----

    // Packets on one channel are protected and sent strictly in order, so
    // the SRTCP index on the wire never goes backwards.
    _sendRtcp(channel, plain) {
        const ctx = channel === CHANNEL_VIDEO ? this._ctx.videoOut : this._ctx.audioOut;
        this._sendChain[channel] = this._sendChain[channel].then(async () => {
            const packet = await ctx.protectRtcp(plain);
            if (!this._ws || !this._wsOpen) return;
            const msg = new Uint8Array(packet.length + 1);
            msg[0] = channel;
            msg.set(packet, 1);
            this._ws.send(msg);
            this.stats.sent++;
        }).catch(() => {});
    }

    // End the session when the machine has been behind for too long.
    _checkLoad(now) {
        const backlog = (this._sink && this._sink.backlog) || 0;
        if (backlog <= OVERLOAD_PICTURES && this._decrypting <= OVERLOAD_PACKETS) {
            this._overloadedSince = null;
        } else if (this._overloadedSince === null) {
            this._overloadedSince = now;
        } else if (now - this._overloadedSince >= OVERLOAD_MS) {
            this._fail('overloaded', backlog + ' pictures and ' + this._decrypting + ' packets behind');
        }
    }

    _tick() {
        const now = this._now();
        if (this._assembler) this._assembler.tick(now);
        this._checkLoad(now);
        if (this.state === 'streaming' && this._lastMediaAt !== null &&
            now - this._lastMediaAt > MEDIA_SILENCE_MS) {
            this._fail('media-stopped');
        }
        if (!this._feedback.rateControl || this.state === 'failed') return;
        const sinceLast = this._lastVideoPacketAt === null ? 0 : now - this._lastVideoPacketAt;
        this._sendRtcp(CHANNEL_VIDEO, rateControl({
            ssrc: this._secrets.videoSsrc,
            a: this.stats.pictures & 0xffff,
            b: sinceLast,
            c: this.stats.videoPackets,
            d: IDLE_BANDWIDTH_KBIT,
        }));
    }

    _sendReports() {
        if (!this._feedback.reports) return;
        const now = this._now();
        const report = (channel, ssrc, sourceSsrc, tracker) => {
            if (tracker.highest === null) return;
            const sr = this._lastSenderReport[channel];
            this._sendRtcp(channel, receiverReport({
                ssrc,
                sourceSsrc,
                highestSeq: tracker.highest,
                lsr: sr ? sr.middle : 0,
                dlsr: sr ? Math.round((now - sr.at) * 65.536) : 0,
            }));
        };
        report(CHANNEL_AUDIO, this._secrets.audioSsrc, this._answer.audio.ssrc, this._audioSeq);
        report(CHANNEL_VIDEO, this._secrets.videoSsrc, this._answer.video.ssrc, this._videoSeq);
    }
}
