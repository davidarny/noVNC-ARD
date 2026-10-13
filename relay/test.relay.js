/*
 * Tests for the relay: static files, WebSocket↔TCP bridge, /media WebSocket↔UDP bridge
 *
 * Everything runs on loopback against local echo servers on ephemeral ports.
 *
 * Run: node --test relay/test.relay.js
 */

import { describe, it, before, after } from 'node:test';
import { deepStrictEqual, strictEqual, notStrictEqual, ok, match, rejects } from 'node:assert';
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startRelay, frameHeader } from './relay.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const GREETING = 'RFB 003.889\n';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: reject if a promise has not settled in time, so a failure is a
// message and not a hung test run
function within(promise, what, ms = 2000) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Helper: an async queue; take() waits for the next pushed item
function queue(what) {
    const items = [];
    const waiters = [];
    return {
        push(item) {
            const waiter = waiters.shift();
            if (waiter) {
                waiter(item);
            } else {
                items.push(item);
            }
        },
        take(ms) {
            if (items.length) return Promise.resolve(items.shift());
            return within(new Promise(resolve => waiters.push(resolve)), what, ms);
        },
        get length() { return items.length; },
    };
}

// Helper: one masked client frame
function clientFrame(opcode, payload, fin = true) {
    const body = Buffer.from(payload);
    const len = body.length;
    let head;
    if (len < 126) {
        head = Buffer.from([0, 0x80 | len]);
    } else if (len < 65536) {
        head = Buffer.alloc(4);
        head[1] = 0x80 | 126;
        head.writeUInt16BE(len, 2);
    } else {
        head = Buffer.alloc(10);
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = (fin ? 0x80 : 0) | opcode;
    const mask = crypto.randomBytes(4);
    for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, body]);
}

// Minimal WebSocket client (Node 20 has no global WebSocket). Written apart
// from the relay's own framing code so the two check each other.
class Client {
    static connect(port, urlPath = '/websockify', extraHeaders = '') {
        return within(new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            const key = crypto.randomBytes(16).toString('base64');
            let buf = Buffer.alloc(0);
            socket.setNoDelay(true);
            socket.on('error', reject);
            socket.on('connect', () => {
                socket.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
                             'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                             `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                             `${extraHeaders}\r\n`);
            });
            const onData = (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) return;
                socket.off('data', onData);
                const [status, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
                const headers = {};
                for (const line of lines) {
                    const colon = line.indexOf(':');
                    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
                }
                const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
                if (!status.startsWith('HTTP/1.1 101') || headers['sec-websocket-accept'] !== accept) {
                    socket.destroy();
                    reject(new Error(`handshake refused: ${status}`));
                    return;
                }
                const client = new Client(socket, headers);
                client.feed(buf.subarray(end + 4));
                resolve(client);
            };
            socket.on('data', onData);
        }), `WebSocket handshake on ${urlPath}`);
    }

    constructor(socket, headers) {
        this.socket = socket;
        this.headers = headers;
        this.messages = queue('a WebSocket message');
        this.pongs = queue('a pong');
        this.violations = [];          // anything a server must not send
        this.buf = Buffer.alloc(0);
        this.pending = Buffer.alloc(0);
        // The server's close frame, or code null if the socket just closed
        this.closed = new Promise((resolve) => { this._closed = resolve; });
        this.ended = new Promise(resolve => socket.on('close', resolve));
        socket.on('data', chunk => this.feed(chunk));
        socket.on('error', () => {});
        socket.on('close', () => this._closed({ code: null, reason: '' }));
    }

    feed(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            const len7 = b1 & 0x7f;
            let offset = 2;
            let len = len7;
            if (len7 === 126) {
                if (this.buf.length < 4) return;
                len = this.buf.readUInt16BE(2);
                offset = 4;
            } else if (len7 === 127) {
                if (this.buf.length < 10) return;
                len = Number(this.buf.readBigUInt64BE(2));
                offset = 10;
            }
            if (this.buf.length < offset + len) return;
            const payload = Buffer.from(this.buf.subarray(offset, offset + len));
            this.buf = this.buf.subarray(offset + len);

            if (b1 & 0x80 || b0 & 0x70) this.violations.push('masked or reserved bits');
            if (!(b0 & 0x80)) this.violations.push('fragmented frame');
            switch (b0 & 0x0f) {
                case 0x2: this.messages.push(payload); break;
                case 0xA: this.pongs.push(payload); break;
                case 0x8:
                    this._closed({
                        code: len >= 2 ? payload.readUInt16BE(0) : null,
                        reason: payload.subarray(2).toString(),
                    });
                    break;
                default: this.violations.push(`opcode ${b0 & 0x0f}`);
            }
        }
    }

    // The next n bytes of binary message data, across message boundaries
    async read(n) {
        while (this.pending.length < n) {
            this.pending = Buffer.concat([this.pending, await this.messages.take()]);
        }
        const out = this.pending.subarray(0, n);
        this.pending = this.pending.subarray(n);
        return out;
    }

    send(payload) { this.socket.write(clientFrame(0x2, payload)); }
    raw(bytes) { this.socket.write(bytes); }
    whenClosed() { return within(this.closed, 'the close frame'); }

    async ping() {
        const token = crypto.randomBytes(4);
        this.raw(clientFrame(0x9, token));
        deepStrictEqual(await this.pongs.take(), token);
    }

    destroy() { this.socket.destroy(); }
}

// Helper: raw HTTP request, so the path reaches the server exactly as written
function httpRequest(port, method, rawPath, headers = 'Connection: close\r\n') {
    return within(new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks = [];
        socket.on('error', reject);
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('close', () => {
            const raw = Buffer.concat(chunks);
            const split = raw.indexOf('\r\n\r\n');
            const [statusLine, ...lines] = raw.subarray(0, split).toString('latin1').split('\r\n');
            const responseHeaders = {};
            for (const line of lines) {
                const colon = line.indexOf(':');
                responseHeaders[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
            }
            resolve({
                status: Number(statusLine.split(' ')[1]),
                headers: responseHeaders,
                body: raw.subarray(split + 4),
            });
        });
        socket.write(`${method} ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}\r\n`);
    }), `the response to ${method} ${rawPath}`);
}

// Helper: TCP target that greets first (as an RFB server does) and then echoes
function startTcpEcho() {
    return new Promise((resolve) => {
        const sockets = new Set();
        const connections = queue('a TCP connection at the target');
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => sockets.delete(socket));
            socket.write(GREETING);
            socket.pipe(socket);
            connections.push(socket);
        });
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            connections,
            close: () => new Promise((done) => {
                for (const socket of sockets) socket.destroy();
                server.close(done);
            }),
        }));
    });
}

// Helper: UDP socket on loopback that echoes each datagram to its sender
function startUdpEcho() {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const received = queue('a datagram at the target');
        socket.on('message', (msg, rinfo) => {
            received.push({ msg, rinfo });
            socket.send(msg, rinfo.port, rinfo.address);
        });
        socket.bind(0, '127.0.0.1', () => resolve({
            socket,
            port: socket.address().port,
            received,
            sendTo: (port, bytes) => socket.send(bytes, port, '127.0.0.1'),
            close: () => new Promise(done => socket.close(done)),
        }));
    });
}

// Helper: a TCP port with nothing listening on it
function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

describe('relay', () => {
    const quiet = () => {};
    let tmp, web, target, echo, relay;
    const clients = [];

    async function connect(urlPath, extraHeaders) {
        const client = await Client.connect(relay.port, urlPath, extraHeaders);
        clients.push(client);
        return client;
    }

    // A bridged client with the target's greeting consumed, and the target's
    // end of the TCP connection
    async function openBridge(urlPath = '/websockify') {
        const client = await connect(urlPath);
        const peer = await target.connections.take();
        strictEqual((await client.read(GREETING.length)).toString(), GREETING);
        return { client, peer };
    }

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
        web = path.join(tmp, 'web');
        fs.mkdirSync(path.join(web, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the web root');
        fs.writeFileSync(path.join(web, 'app.js'), 'export const answer = 42;\n');
        fs.writeFileSync(path.join(web, 'sub', 'data.json'), '{"a":1}');
        fs.writeFileSync(path.join(web, '.hidden'), 'dotfile');
        for (const name of ['a.html', 'a.mjs', 'a.css', 'a.svg', 'a.png', 'a.ico', 'a.wasm', 'a.bin']) {
            fs.writeFileSync(path.join(web, name), 'x');
        }

        target = await startTcpEcho();
        echo = [await startUdpEcho(), await startUdpEcho()];
        relay = await startRelay({
            listen: 0,
            targetHost: '127.0.0.1',
            targetPort: target.port,
            web,
            udpPorts: echo.map(e => e.port),
            udpLocalPorts: [0, 0],
            log: quiet,
        });
    });

    after(async () => {
        for (const client of clients) client.destroy();
        await relay.close();
        await target.close();
        await Promise.all(echo.map(e => e.close()));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ===================================================================
    //  Frame header
    // ===================================================================
    describe('frame header', () => {
        it('uses a 7-bit length up to 125 bytes', () => {
            deepStrictEqual([...frameHeader(0x2, 0)], [0x82, 0]);
            deepStrictEqual([...frameHeader(0x2, 125)], [0x82, 125]);
        });

        it('uses a 16-bit length from 126 to 65535 bytes', () => {
            deepStrictEqual([...frameHeader(0x2, 126)], [0x82, 126, 0x00, 0x7e]);
            deepStrictEqual([...frameHeader(0x2, 65535)], [0x82, 126, 0xff, 0xff]);
        });

        it('uses a 64-bit length from 65536 bytes', () => {
            deepStrictEqual([...frameHeader(0x2, 65536)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]);
            deepStrictEqual([...frameHeader(0x8, 0x123456789)],
                            [0x88, 127, 0, 0, 0, 1, 0x23, 0x45, 0x67, 0x89]);
        });
    });

    // ===================================================================
    //  Static files
    // ===================================================================
    describe('static files', () => {
        it('serves a file under the web root', async () => {
            const res = await httpRequest(relay.port, 'GET', '/app.js');
            strictEqual(res.status, 200);
            match(res.headers['content-type'], /javascript/);
            strictEqual(res.headers['content-length'], '26');
            strictEqual(res.body.toString(), 'export const answer = 42;\n');
        });

        it('serves a file in a subdirectory, ignoring the query string', async () => {
            const res = await httpRequest(relay.port, 'GET', '/sub/data.json?v=1');
            strictEqual(res.status, 200);
            match(res.headers['content-type'], /^application\/json/);
            strictEqual(res.body.toString(), '{"a":1}');
        });

        it('sets the content type from the extension', async () => {
            const expected = {
                'a.html': /^text\/html/,
                'a.mjs': /javascript/,
                'a.css': /^text\/css/,
                'a.svg': /^image\/svg\+xml/,
                'a.png': /^image\/png/,
                'a.ico': /^image\//,
                'a.wasm': /^application\/wasm/,
                'a.bin': /^application\/octet-stream/,
            };
            for (const [name, type] of Object.entries(expected)) {
                const res = await httpRequest(relay.port, 'GET', `/${name}`);
                strictEqual(res.status, 200, name);
                match(res.headers['content-type'], type);
            }
        });

        it('answers HEAD without a body', async () => {
            const res = await httpRequest(relay.port, 'HEAD', '/app.js');
            strictEqual(res.status, 200);
            strictEqual(res.headers['content-length'], '26');
            strictEqual(res.body.length, 0);
        });

        it('answers 404 for a missing file, a directory and the root', async () => {
            for (const p of ['/missing.js', '/sub', '/sub/', '/']) {
                strictEqual((await httpRequest(relay.port, 'GET', p)).status, 404, p);
            }
        });

        it('refuses path traversal', async () => {
            const attempts = [
                '/../secret.txt',
                '/sub/../../secret.txt',
                '/%2e%2e/secret.txt',
                '/%2e%2e%2fsecret.txt',
                '/sub/..%2f..%2fsecret.txt',
                '/..%5csecret.txt',
                '//../secret.txt',
                '/app.js%00.txt',
                '/%zz',
            ];
            for (const p of attempts) {
                const res = await httpRequest(relay.port, 'GET', p);
                ok(res.status >= 400 && res.status < 500, `${p} → ${res.status}`);
                ok(!res.body.includes('outside the web root'), p);
            }
        });

        it('does not serve dotfiles', async () => {
            strictEqual((await httpRequest(relay.port, 'GET', '/.hidden')).status, 404);
        });

        it('refuses methods other than GET and HEAD', async () => {
            const res = await httpRequest(relay.port, 'POST', '/app.js',
                                          'Connection: close\r\nContent-Length: 0\r\n');
            strictEqual(res.status, 405);
        });

        it('refuses an upgrade without a WebSocket key', async () => {
            const res = await httpRequest(relay.port, 'GET', '/websockify',
                                          'Connection: Upgrade\r\nUpgrade: websocket\r\n');
            strictEqual(res.status, 400);
        });
    });

    // ===================================================================
    //  WebSocket ↔ TCP
    // ===================================================================
    describe('WebSocket to TCP bridge', () => {
        it('delivers data the target sends first', async () => {
            const { client } = await openBridge();
            deepStrictEqual(client.violations, []);
        });

        it('carries binary data both ways unchanged', async () => {
            const { client } = await openBridge();
            const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
            client.send(data);
            deepStrictEqual(await client.read(256), data);
            client.send(Buffer.from([0x00, 0xff, 0x80]));
            deepStrictEqual(await client.read(3), Buffer.from([0x00, 0xff, 0x80]));
            deepStrictEqual(client.violations, []);
        });

        it('bridges any path except /media', async () => {
            const { client } = await openBridge('/some/other/path?token=1');
            client.send(Buffer.from('hello'));
            strictEqual((await client.read(5)).toString(), 'hello');
        });

        it('handles every frame length encoding, up to a 70 kB message', async () => {
            const { client } = await openBridge();
            for (const size of [0, 1, 125, 126, 65535, 65536, 70000]) {
                const data = crypto.randomBytes(size);
                client.send(data);
                client.send(Buffer.from([0xee]));
                ok((await client.read(size)).equals(data), `${size} byte message`);
                deepStrictEqual(await client.read(1), Buffer.from([0xee]));
            }
            deepStrictEqual(client.violations, []);
        });

        it('reassembles a fragmented message', async () => {
            const { client } = await openBridge();
            client.raw(clientFrame(0x2, 'abc', false));
            client.raw(clientFrame(0x0, 'def', false));
            client.raw(clientFrame(0x0, '', false));
            client.raw(clientFrame(0x0, 'ghi', true));
            strictEqual((await client.read(9)).toString(), 'abcdefghi');
        });

        it('answers a ping between the fragments of a message', async () => {
            const { client } = await openBridge();
            client.raw(clientFrame(0x2, 'abc', false));
            await client.ping();
            client.raw(clientFrame(0x0, 'def', true));
            strictEqual((await client.read(6)).toString(), 'abcdef');
        });

        it('parses a frame split across TCP chunks', async () => {
            const { client } = await openBridge();
            const data = crypto.randomBytes(300);
            const frame = clientFrame(0x2, data);      // 8 header bytes
            let from = 0;
            for (const cut of [1, 3, 6, 9, 150, frame.length]) {
                client.raw(frame.subarray(from, cut));
                from = cut;
                await sleep(15);
            }
            ok((await client.read(300)).equals(data));
        });

        it('parses frames coalesced into one TCP chunk', async () => {
            const { client } = await openBridge();
            const token = Buffer.from('p');
            client.raw(Buffer.concat([
                clientFrame(0x2, 'one'),
                clientFrame(0x9, token),
                clientFrame(0x2, 'two', false),
                clientFrame(0x0, 'three'),
                clientFrame(0x2, 'four'),
            ]));
            deepStrictEqual(await client.pongs.take(), token);
            strictEqual((await client.read(15)).toString(), 'onetwothreefour');
        });

        it('completes the close handshake and closes the target', async () => {
            const { client, peer } = await openBridge();
            const targetClosed = new Promise(resolve => peer.on('close', resolve));
            const code = Buffer.alloc(2);
            code.writeUInt16BE(1000);
            client.raw(clientFrame(0x8, code));
            strictEqual((await client.whenClosed()).code, 1000);
            await within(targetClosed, 'the target connection to close');
            await within(client.ended, 'the WebSocket socket to close');
        });

        it('closes the target when the client disappears', async () => {
            const { client, peer } = await openBridge();
            const targetClosed = new Promise(resolve => peer.on('close', resolve));
            client.destroy();
            await within(targetClosed, 'the target connection to close');
        });

        it('closes the client when the target closes', async () => {
            const { client, peer } = await openBridge();
            peer.end('bye');
            strictEqual((await client.read(3)).toString(), 'bye');
            strictEqual((await client.whenClosed()).code, 1000);
            await within(client.ended, 'the WebSocket socket to close');
        });

        it('closes the client when the target refuses the connection', async () => {
            const refused = await startRelay({
                listen: 0,
                targetHost: '127.0.0.1',
                targetPort: await closedPort(),
                web,
                udpLocalPorts: [0, 0],
                log: quiet,
            });
            try {
                const client = await Client.connect(refused.port);
                strictEqual((await client.whenClosed()).code, 1011);
                await within(client.ended, 'the WebSocket socket to close');
            } finally {
                await refused.close();
            }
        });

        it('rejects text frames, as websockify does', async () => {
            const { client } = await openBridge();
            client.raw(clientFrame(0x1, 'text'));
            strictEqual((await client.whenClosed()).code, 1003);
        });

        it('rejects an unmasked client frame', async () => {
            const { client } = await openBridge();
            client.raw(Buffer.from([0x82, 0x01, 0x41]));
            strictEqual((await client.whenClosed()).code, 1002);
        });

        it('echoes the binary subprotocol when offered', async () => {
            const client = await connect('/websockify', 'Sec-WebSocket-Protocol: base64, binary\r\n');
            strictEqual(client.headers['sec-websocket-protocol'], 'binary');
        });

        it('echoes the first subprotocol when binary is not offered', async () => {
            const client = await connect('/websockify', 'Sec-WebSocket-Protocol: foo, bar\r\n');
            strictEqual(client.headers['sec-websocket-protocol'], 'foo');
        });

        it('selects no subprotocol when none is offered', async () => {
            const client = await connect('/websockify');
            strictEqual(client.headers['sec-websocket-protocol'], undefined);
        });
    });

    // ===================================================================
    //  WebSocket /media ↔ UDP
    // ===================================================================
    describe('media bridge', () => {
        // Close a media client and wait until the relay has seen it go
        async function hangUp(client) {
            const code = Buffer.alloc(2);
            code.writeUInt16BE(1000);
            client.raw(clientFrame(0x8, code));
            await client.whenClosed();
        }

        for (const n of [0, 1]) {
            it(`round trips a datagram on channel ${n}`, async () => {
                const client = await connect('/media');
                const datagram = crypto.randomBytes(1200);
                client.send(Buffer.concat([Buffer.from([n]), datagram]));

                // Sent from local socket n to the target's port n, contents unchanged
                const { msg, rinfo } = await echo[n].received.take();
                ok(msg.equals(datagram));
                strictEqual(rinfo.port, relay.udpLocalPorts[n]);

                const back = await client.messages.take();
                strictEqual(back[0], n);
                ok(back.subarray(1).equals(datagram));
                deepStrictEqual(client.violations, []);
                await hangUp(client);
            });
        }

        it('keeps datagram boundaries, including an empty datagram', async () => {
            const client = await connect('/media');
            client.send(Buffer.from([1, 0xaa]));
            client.send(Buffer.from([1]));
            client.send(Buffer.from([1, 0xbb, 0xcc]));
            deepStrictEqual(await client.messages.take(), Buffer.from([1, 0xaa]));
            deepStrictEqual(await client.messages.take(), Buffer.from([1]));
            deepStrictEqual(await client.messages.take(), Buffer.from([1, 0xbb, 0xcc]));
            for (let i = 0; i < 3; i++) await echo[1].received.take();
            await hangUp(client);
        });

        it('forwards a datagram the target sends unprompted', async () => {
            const client = await connect('/media');
            await client.ping();
            echo[0].sendTo(relay.udpLocalPorts[0], Buffer.from('audio'));
            echo[1].sendTo(relay.udpLocalPorts[1], Buffer.from('video'));
            const got = [await client.messages.take(), await client.messages.take()]
                .map(m => `${m[0]}:${m.subarray(1)}`).sort();
            deepStrictEqual(got, ['0:audio', '1:video']);
            await hangUp(client);
        });

        it('ignores a message with an unknown channel or no channel byte', async () => {
            const client = await connect('/media');
            client.send(Buffer.from([2, 0x01]));
            client.send(Buffer.alloc(0));
            client.send(Buffer.from([0, 0x02]));
            deepStrictEqual(await client.messages.take(), Buffer.from([0, 0x02]));
            deepStrictEqual((await echo[0].received.take()).msg, Buffer.from([0x02]));
            strictEqual(echo[0].received.length, 0);
            strictEqual(echo[1].received.length, 0);
            await hangUp(client);
        });

        it('closes a media client whose message is larger than a datagram', async () => {
            const client = await connect('/media');
            // Header only: 64-bit length of 1 MiB, then the mask key
            const head = Buffer.alloc(14);
            head[0] = 0x82;
            head[1] = 0x80 | 127;
            head.writeBigUInt64BE(1n << 20n, 2);
            client.raw(head);
            strictEqual((await client.whenClosed()).code, 1009);
        });

        it('drops a datagram that arrives with no media client', async () => {
            echo[0].sendTo(relay.udpLocalPorts[0], Buffer.from('nobody listening'));
            await sleep(50);
            const client = await connect('/media');
            await client.ping();
            echo[0].sendTo(relay.udpLocalPorts[0], Buffer.from('second'));
            strictEqual((await client.messages.take()).subarray(1).toString(), 'second');
            await hangUp(client);
        });

        it('drops a datagram from an address other than the target', async () => {
            // This relay's target is a documentation address (RFC 5737), so
            // the loopback sender below is a foreign source. Nothing is ever
            // sent to the target.
            const other = await startRelay({
                listen: 0,
                targetHost: '192.0.2.1',
                web,
                udpLocalPorts: [0, 0],
                log: quiet,
            });
            try {
                const client = await Client.connect(other.port, '/media');
                await client.ping();
                echo[0].sendTo(other.udpLocalPorts[0], Buffer.from('foreign'));
                echo[1].sendTo(other.udpLocalPorts[1], Buffer.from('foreign'));
                await sleep(150);
                await client.ping();
                strictEqual(client.messages.length, 0);
                client.destroy();
            } finally {
                await other.close();
            }
        });

        it('replaces the media client when a second one connects', async () => {
            const first = await connect('/media');
            await first.ping();
            const second = await connect('/media');
            notStrictEqual((await first.whenClosed()).code, null);
            await within(first.ended, 'the first media client to close');

            // The first client going away must not detach the second
            await second.ping();
            echo[1].sendTo(relay.udpLocalPorts[1], Buffer.from('picture'));
            deepStrictEqual(await second.messages.take(),
                            Buffer.concat([Buffer.from([1]), Buffer.from('picture')]));
            strictEqual(first.messages.length, 0);

            second.send(Buffer.from([0, 0x07]));
            deepStrictEqual(await second.messages.take(), Buffer.from([0, 0x07]));
            await echo[0].received.take();
            await hangUp(second);
        });

        it('logs a counters line while a media client is connected', async () => {
            const lines = [];
            const counted = await startRelay({
                listen: 0,
                targetHost: '127.0.0.1',
                targetPort: target.port,
                web,
                udpPorts: echo.map(e => e.port),
                udpLocalPorts: [0, 0],
                countersMs: 20,
                log: line => lines.push(line),
            });
            try {
                const client = await Client.connect(counted.port, '/media');
                client.send(Buffer.from([0, 1, 2, 3]));
                await client.messages.take();
                await echo[0].received.take();
                const seen = () => lines.find(l => /^media: .*ch0 .*ch1 /.test(l) && /\b1\b/.test(l));
                for (let i = 0; i < 50 && !seen(); i++) await sleep(20);
                ok(seen(), `no counters line in:\n${lines.join('\n')}`);
                client.destroy();
            } finally {
                await counted.close();
            }
        });
    });

    // ===================================================================
    //  Startup
    // ===================================================================
    describe('startup', () => {
        it('rejects, naming the port, when a UDP port cannot be bound', async () => {
            const blocker = dgram.createSocket('udp4');
            await new Promise(resolve => blocker.bind(0, '0.0.0.0', resolve));
            const { port } = blocker.address();
            try {
                await rejects(startRelay({
                    listen: 0,
                    targetHost: '127.0.0.1',
                    web,
                    udpLocalPorts: [0, port],
                    log: quiet,
                }), new RegExp(`UDP port ${port}\\b`));
            } finally {
                await new Promise(resolve => blocker.close(resolve));
            }
        });

        it('rejects without a target host', async () => {
            await rejects(startRelay({ listen: 0, web, udpLocalPorts: [0, 0], log: quiet }), /target/i);
        });

        it('prints usage and exits non-zero on bad arguments', () => {
            const script = fileURLToPath(new URL('./relay.mjs', import.meta.url));
            const cases = [
                [],
                ['--listen', '6088'],
                ['--listen', 'abc', '--target', '127.0.0.1'],
                ['--listen', '6088', '--target', '127.0.0.1:99999'],
                ['--listen', '6088', '--target', '127.0.0.1', '--bogus', '1'],
                ['--listen', '6088', '--target'],
            ];
            for (const args of cases) {
                const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
                notStrictEqual(run.status, 0, args.join(' '));
                notStrictEqual(run.status, null, args.join(' '));
                match(run.stderr, /usage:/i);
            }
        });
    });
});
