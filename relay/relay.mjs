/*
 * noVNC-ARD: protocol-blind relay
 *
 * Serves the web client, bridges WebSocket connections to the target's TCP
 * port (as websockify does) and bridges one WebSocket on /media to the
 * target's UDP media ports. It moves bytes and datagrams, never looks inside
 * them and keeps no session state.
 *
 * Run: node relay/relay.mjs --listen 6088 --target HOST[:5900] [--web DIR] [--host 127.0.0.1]
 *
 * A WebSocket is a way into the target, so a web page may open one only if
 * it was served by this relay (see originAllowed). Run the relay where only
 * the people meant to reach the target can reach it: it does not ask who
 * they are.
 */

import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import os from 'node:os';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node relay/relay.mjs --listen PORT --target HOST[:PORT] [--web DIR] [--host ADDRESS]
                             [--allow-origin ORIGIN]...

  --listen PORT         HTTP and WebSocket port
  --target HOST[:PORT]  the Mac to relay to; PORT is its TCP port (default 5900)
  --web DIR             directory of static files to serve (default: the repository root)
  --host ADDRESS        address to listen on (default 127.0.0.1)
  --allow-origin ORIGIN another web origin whose pages may connect, for example
                        https://viewer.example.com; may be given more than once

Pages served by the relay itself may always connect, when opened by IP
address, as localhost or under this machine's own name.

UDP ports 5900 and 5901 are bound on all addresses for the media bridge.`;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// The media endpoint and the subprotocol only it agrees to
const MEDIA_PATH = '/media';
const MEDIA_SUBPROTOCOL = 'ard-media';
// Path segments that are never served, as dotfiles are not: local notes
// that live in the repository directory without being part of it
const UNSERVED_SEGMENTS = new Set(['private', 'node_modules']);

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xA;

// Largest client message accepted on the TCP bridge
const MAX_TCP_MESSAGE = 16 * 1024 * 1024;
// One channel byte and the largest possible UDP datagram
const MAX_MEDIA_MESSAGE = 1 + 65535;
// Media is real time: when the media client is this far behind, new datagrams
// are dropped rather than queued
const MEDIA_BACKLOG_LIMIT = 4 * 1024 * 1024;
// How long a peer has to finish the close handshake before its socket is destroyed
const CLOSE_TIMEOUT_MS = 2000;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
};

// ===================================================================
//  WebSocket framing (RFC 6455, server side)
// ===================================================================

// Header of an unmasked final frame carrying `length` payload bytes
export function frameHeader(opcode, length) {
    let header;
    if (length < 126) {
        header = Buffer.allocUnsafe(2);
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.allocUnsafe(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[1] = 127;
        header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
        header.writeUInt32BE(length >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    return header;
}

// Turns the bytes a client sends into whole messages and control frames.
// Frames may arrive split across chunks or several to a chunk.
class FrameReader {
    constructor(maxMessage, { onMessage, onControl, onError }) {
        this.maxMessage = maxMessage;
        this.onMessage = onMessage;     // (opcode, Buffer) a whole data message
        this.onControl = onControl;     // (opcode, Buffer) ping, pong or close
        this.onError = onError;         // (closeCode, reason) protocol violation; reading stops
        this.chunks = [];
        this.have = 0;                  // bytes held in chunks
        this.need = 2;                  // bytes required before the next parse attempt
        this.fragments = null;          // payloads of the message being assembled
        this.fragmentsLength = 0;
        this.messageOpcode = 0;
        this.stopped = false;
    }

    stop() {
        this.stopped = true;
        this.chunks = [];
        this.fragments = null;
    }

    push(chunk) {
        if (this.stopped) return;
        this.chunks.push(chunk);
        this.have += chunk.length;
        // Chunks are joined only once enough bytes are held, so a large frame
        // arriving in many pieces is copied a bounded number of times.
        while (!this.stopped && this.have >= this.need) {
            const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.have);
            const used = this._frame(buf);
            if (this.stopped) return;
            const rest = buf.subarray(used);
            this.chunks = rest.length ? [rest] : [];
            this.have = rest.length;
        }
    }

    // Parse one frame at the start of buf. Returns the bytes consumed, or 0
    // after raising this.need because the frame is not all here yet.
    _frame(buf) {
        const b0 = buf[0];
        const b1 = buf[1];
        if (b0 & 0x70) return this._fail(1002, 'Reserved bits set');
        if (!(b1 & 0x80)) return this._fail(1002, 'Client frame not masked');

        const len7 = b1 & 0x7f;
        const headerLength = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + 4;
        if (buf.length < headerLength) {
            this.need = headerLength;
            return 0;
        }
        let length = len7;
        if (len7 === 126) {
            length = buf.readUInt16BE(2);
        } else if (len7 === 127) {
            length = buf.readUInt32BE(2) * 0x100000000 + buf.readUInt32BE(6);
        }
        if (length > this.maxMessage) return this._fail(1009, 'Message too big');

        const total = headerLength + length;
        if (buf.length < total) {
            this.need = total;
            return 0;
        }
        const mask = buf.subarray(headerLength - 4, headerLength);
        const payload = buf.subarray(headerLength, total);
        for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];

        this.need = 2;
        this._dispatch((b0 & 0x80) !== 0, b0 & 0x0f, payload);
        return total;
    }

    _dispatch(fin, opcode, payload) {
        if (opcode >= 0x8) {
            if (opcode > OP_PONG) return this._fail(1002, 'Unknown opcode');
            if (!fin || payload.length > 125) return this._fail(1002, 'Bad control frame');
            this.onControl(opcode, payload);
            return 0;
        }

        if (opcode === OP_CONTINUATION) {
            if (this.fragments === null) return this._fail(1002, 'Continuation without a message');
        } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
            if (this.fragments !== null) return this._fail(1002, 'Message interrupted by another');
            this.fragments = [];
            this.fragmentsLength = 0;
            this.messageOpcode = opcode;
        } else {
            return this._fail(1002, 'Unknown opcode');
        }

        this.fragmentsLength += payload.length;
        if (this.fragmentsLength > this.maxMessage) return this._fail(1009, 'Message too big');
        if (!fin) {
            this.fragments.push(payload);
            return 0;
        }
        let message = payload;
        if (this.fragments.length) {
            this.fragments.push(payload);
            message = Buffer.concat(this.fragments, this.fragmentsLength);
        }
        this.fragments = null;
        this.onMessage(this.messageOpcode, message);
        return 0;
    }

    _fail(code, reason) {
        this.stop();
        this.onError(code, reason);
        return 0;
    }
}

// One accepted WebSocket connection. Set onMessage and onClose, then call
// receive() with the bytes that came in with the upgrade request.
class WsConnection {
    constructor(socket, maxMessage) {
        this.socket = socket;
        this.onMessage = () => {};      // (Buffer) one whole binary message
        this.onClose = () => {};        // (code, reason) once, whatever ended the connection
        this.closeSent = false;
        this.finished = false;
        this.reader = new FrameReader(maxMessage, {
            onMessage: (opcode, data) => this._message(opcode, data),
            onControl: (opcode, data) => this._control(opcode, data),
            onError: (code, reason) => this.close(code, reason),
        });

        socket.setNoDelay(true);
        socket.setTimeout(0);
        socket.on('data', chunk => this.reader.push(chunk));
        socket.on('error', () => {});   // 'close' follows
        socket.on('end', () => {
            this._finish(1006, 'Connection lost');
            socket.end();
        });
        socket.on('close', () => this._finish(1006, 'Connection lost'));
    }

    receive(head) {
        if (head && head.length) this.reader.push(head);
        this.socket.resume();
    }

    // Send one binary message made of the given parts. False means the
    // socket's buffer is full and the caller should wait for 'drain'.
    send(...parts) {
        if (this.closeSent || !this.socket.writable) return true;
        return this._send(OP_BINARY, parts);
    }

    // Start (or answer) the close handshake. Safe to call more than once.
    close(code = 1000, reason = '') {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        this._shutdown(payload, code, reason);
    }

    _send(opcode, parts) {
        const socket = this.socket;
        let length = 0;
        for (const part of parts) length += part.length;
        socket.cork();
        let ok = socket.write(frameHeader(opcode, length));
        for (const part of parts) ok = socket.write(part);
        socket.uncork();
        return ok;
    }

    _message(opcode, data) {
        if (opcode !== OP_BINARY) {
            this.close(1003, 'Text frames are not supported');
            return;
        }
        this.onMessage(data);
    }

    _control(opcode, data) {
        if (opcode === OP_PING) {
            if (this.socket.writable) this._send(OP_PONG, [data]);
        } else if (opcode === OP_CLOSE) {
            // Answer with the peer's status code and no reason
            const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
            this._shutdown(data.subarray(0, 2), code, data.subarray(2).toString());
        }
    }

    _shutdown(closePayload, code, reason) {
        if (this.closeSent) return;
        this.closeSent = true;
        this.reader.stop();
        const socket = this.socket;
        if (socket.writable) {
            this._send(OP_CLOSE, [closePayload]);
            socket.end();
        }
        // Keep reading so the peer's FIN is seen, but do not wait for ever
        socket.resume();
        const timer = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT_MS);
        timer.unref();
        socket.once('close', () => clearTimeout(timer));
        this._finish(code, reason);
    }

    _finish(code, reason) {
        if (this.finished) return;
        this.finished = true;
        this.reader.stop();
        this.onClose(code, reason);
    }
}

function refuseUpgrade(socket, status, extraHeader = '') {
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extraHeader}\r\n`);
}

// The subprotocols a client offers, in its order of preference.
function offeredProtocols(req) {
    return String(req.headers['sec-websocket-protocol'] || '')
        .split(',').map(name => name.trim()).filter(Boolean);
}

// The host of a Host header or URL authority, without port or brackets.
function hostnameOf(authority) {
    try {
        return new URL('http://' + authority).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
        return null;
    }
}

/*
 * May the page that sent this upgrade request use the relay?
 *
 * Browsers name the page's origin in every WebSocket handshake and let any
 * page connect anywhere, so without this check any site open in the user's
 * browser could reach the target through a relay on localhost.
 *
 * Allowed: no Origin at all (not a browser page), an origin listed with
 * --allow-origin, and the relay's own pages. A page is the relay's own when
 * its origin is the host the request was sent to, and that host is an IP
 * address, localhost or one of this machine's names. The last condition is
 * what stops a foreign site that points its own name at the relay's address.
 */
function originAllowed(req, allowOrigins, ownNames) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (allowOrigins.has(origin.toLowerCase())) return true;
    let originHost;
    try {
        originHost = new URL(origin).host.toLowerCase();
    } catch {
        return false;
    }
    const host = String(req.headers.host || '').toLowerCase();
    if (!host || originHost !== host) return false;
    const name = hostnameOf(host);
    return name !== null && (net.isIP(name) !== 0 || ownNames.has(name));
}

// Answer the opening handshake, agreeing to `protocol` if one is given.
// Returns the connection, or null if refused.
function acceptWebSocket(req, socket, maxMessage, protocol) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (req.method !== 'GET' || upgrade !== 'websocket' || !key) {
        refuseUpgrade(socket, '400 Bad Request');
        return null;
    }
    if (req.headers['sec-websocket-version'] !== '13') {
        refuseUpgrade(socket, '426 Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
        return null;
    }

    const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + WS_GUID).digest('base64')}`,
    ];
    if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    return new WsConnection(socket, maxMessage);
}

// ===================================================================
//  Static files
// ===================================================================

function reply(res, status, text, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        ...headers,
    });
    res.end(text);
}

function serveStatic(webRoot, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply(res, 405, 'Method Not Allowed\n', { 'Allow': 'GET, HEAD' });
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://relay').pathname);
    } catch {
        reply(res, 400, 'Bad Request\n');
        return;
    }
    // Decoding can produce "..", so containment is checked on the resolved
    // path. Dot segments, dotfiles (.git and the like) and local notes are
    // never served; names are compared without case, as file systems may.
    const file = path.resolve(webRoot, '.' + pathname);
    const hidden = pathname.split(/[/\\]/).some(segment =>
        segment.startsWith('.') || UNSERVED_SEGMENTS.has(segment.toLowerCase()));
    if (pathname.includes('\0') || hidden || !file.startsWith(webRoot + path.sep)) {
        reply(res, 404, 'Not Found\n');
        return;
    }

    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
            reply(res, 404, 'Not Found\n');
            return;
        }
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        pipeline(fs.createReadStream(file), res, () => {});
    });
}

// ===================================================================
//  Relay
// ===================================================================

/*
 * Start a relay. Options:
 *   listen, host      HTTP/WebSocket port and address (6088, 127.0.0.1)
 *   targetHost        the machine to relay to (required)
 *   targetPort        its TCP port (5900)
 *   web               directory of static files (the repository root)
 *   allowOrigins      further web origins whose pages may connect ([])
 *   udpPorts          the target's UDP port for each media channel ([5900, 5901])
 *   udpLocalPorts     the local UDP port for each channel (same as udpPorts)
 *   log               function taking one line (console.log)
 *   countersMs        interval of the media counters line (5000)
 * Resolves to { port, udpLocalPorts, close() } with the ports actually bound.
 */
export async function startRelay(options = {}) {
    const {
        listen = 6088,
        host = '127.0.0.1',
        targetHost,
        targetPort = 5900,
        web = REPO_ROOT,
        allowOrigins = [],
        udpPorts = [5900, 5901],
        udpLocalPorts = udpPorts,
        log = console.log,
        countersMs = 5000,
    } = options;

    if (!targetHost) throw new Error('a target host is required');
    if (udpLocalPorts.length !== udpPorts.length) {
        throw new Error('udpLocalPorts and udpPorts must list the same number of channels');
    }
    const allowedOrigins = new Set(allowOrigins.map(origin => origin.toLowerCase()));
    // Names a browser on this network may know this machine by
    const machine = os.hostname().toLowerCase();
    const ownNames = new Set(['localhost', machine, machine.replace(/\.local$/, '') + '.local']);
    if (!net.isIP(host)) ownNames.add(host.toLowerCase());
    const webRoot = path.resolve(web);
    if (!fs.statSync(webRoot, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`web directory not found: ${webRoot}`);
    }

    // The target sends media to the address of its TCP peer, and the UDP
    // sockets are IPv4, so TCP and UDP both use this one IPv4 address.
    let targetIp;
    try {
        targetIp = (await dns.promises.lookup(targetHost, { family: 4 })).address;
    } catch (err) {
        throw new Error(`cannot resolve target host ${targetHost}: ${err.code || err.message}`);
    }

    // High Performance video runs at tens of Mbit/s. The default UDP receive
    // buffer (~768 KB on macOS) holds only a fraction of a second, so a brief
    // event-loop stall overflows it and the kernel drops packets — a lost
    // picture the HEVC stream cannot decode past. Ask for a large buffer
    // (the kernel caps it at kern.ipc.maxsockbuf).
    const UDP_RECV_BUFFER = 8 * 1024 * 1024;
    const bindUdp = port => new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type: 'udp4', recvBufferSize: UDP_RECV_BUFFER });
        socket.once('error', (err) => {
            socket.close();
            reject(new Error(`cannot bind UDP port ${port}: ${err.code || err.message}`));
        });
        socket.bind(port, '0.0.0.0', () => {
            socket.removeAllListeners('error');
            socket.on('error', err => log(`udp: port ${socket.address().port}: ${err.message}`));
            let got = 0;
            try { got = socket.getRecvBufferSize(); } catch (e) { /* not available */ }
            log(`udp: port ${socket.address().port} recv buffer ${got} B`);
            resolve(socket);
        });
    });

    const udp = [];
    const closeUdp = () => Promise.all(udp.map(socket => new Promise(done => socket.close(done))));
    try {
        for (const port of udpLocalPorts) udp.push(await bindUdp(port));
    } catch (err) {
        await closeUdp();
        throw err;
    }
    const channelByte = udp.map((socket, n) => Buffer.from([n]));

    const sockets = new Set();          // every accepted HTTP/WebSocket socket
    const targets = new Set();          // every TCP connection to the target
    let nextId = 1;

    // ---- /media: WebSocket ↔ UDP ----

    let media = null;                   // the one media client, if any
    let countersTimer = null;
    let channels, dropped;              // counts since the last counters line

    function resetCounters() {
        channels = udp.map(() => ({ inCount: 0, inBytes: 0, outCount: 0, outBytes: 0 }));
        dropped = { foreign: 0, backlog: 0, invalid: 0, failed: 0 };
    }
    resetCounters();

    function logCounters() {
        const parts = channels.map((c, n) =>
            `ch${n} in ${c.inCount} (${c.inBytes} B) out ${c.outCount} (${c.outBytes} B)`);
        const drops = Object.entries(dropped).map(([name, count]) => `${count} ${name}`);
        log(`media: ${parts.join(', ')} dropped ${drops.join(' ')}`);
        resetCounters();
    }

    udp.forEach((socket, n) => {
        socket.on('message', (datagram, rinfo) => {
            if (rinfo.address !== targetIp) {
                dropped.foreign++;
                return;
            }
            if (!media) return;
            if (media.socket.writableLength > MEDIA_BACKLOG_LIMIT) {
                dropped.backlog++;
                return;
            }
            media.send(channelByte[n], datagram);
            channels[n].inCount++;
            channels[n].inBytes += datagram.length;
        });
    });

    // There is one pair of UDP ports, so one media client: the newest. A
    // viewer that only wants to know whether the endpoint is here, and
    // whether it is in use, asks with ?probe and is not attached.
    function answerProbe(ws) {
        ws.close(1000, media ? 'busy' : 'free');
    }

    function attachMedia(ws, peer) {
        if (media) media.close(1000, 'Replaced by a new media client');
        media = ws;
        resetCounters();
        countersTimer = setInterval(logCounters, countersMs);
        countersTimer.unref();
        log(`media: open ${peer}`);

        ws.onMessage = (message) => {
            const n = message[0];
            if (message.length < 1 || n >= udp.length) {
                dropped.invalid++;
                return;
            }
            const datagram = message.subarray(1);
            try {
                udp[n].send(datagram, udpPorts[n], targetIp, (err) => {
                    if (err) dropped.failed++;
                });
            } catch {
                dropped.failed++;
                return;
            }
            channels[n].outCount++;
            channels[n].outBytes += datagram.length;
        };
        ws.onClose = (code) => {
            log(`media: close ${peer} (${code})`);
            if (media !== ws) return;
            media = null;
            clearInterval(countersTimer);
            countersTimer = null;
        };
    }

    // ---- any other path: WebSocket ↔ TCP, as websockify ----

    function bridgeTcp(ws, peer) {
        const id = nextId++;
        const tcp = net.connect({ host: targetIp, port: targetPort });
        let cause = null;
        let clientPaused = false;
        targets.add(tcp);
        tcp.setNoDelay(true);
        log(`tcp #${id}: open ${peer} -> ${targetHost}:${targetPort}`);

        // Bytes written before the connection is up are queued by the socket
        ws.onMessage = (data) => {
            if (!tcp.write(data) && !clientPaused) {
                clientPaused = true;
                ws.socket.pause();
            }
        };
        tcp.on('drain', () => {
            if (!clientPaused) return;
            clientPaused = false;
            ws.socket.resume();
        });
        tcp.on('data', (chunk) => {
            if (!ws.send(chunk)) {
                tcp.pause();
                ws.socket.once('drain', () => tcp.resume());
            }
        });

        ws.onClose = (code) => {
            if (tcp.destroyed) return;
            cause = cause || `client closed (${code})`;
            if (tcp.connecting) {
                tcp.destroy();
            } else {
                tcp.destroySoon();
            }
        };
        tcp.on('error', (err) => {
            cause = cause || `target error: ${err.code || err.message}`;
        });
        tcp.on('close', (hadError) => {
            targets.delete(tcp);
            if (hadError) {
                ws.close(1011, 'Target connection failed');
            } else {
                ws.close(1000, 'Target closed');
            }
            log(`tcp #${id}: close, ${cause || 'target closed'}`);
        });
    }

    // ---- HTTP server ----

    const server = http.createServer((req, res) => serveStatic(webRoot, req, res));

    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    server.on('upgrade', (req, socket, head) => {
        let url;
        try {
            url = new URL(req.url, 'http://relay');
        } catch {
            refuseUpgrade(socket, '400 Bad Request');
            return;
        }
        const peer = `${socket.remoteAddress}:${socket.remotePort}`;
        if (!originAllowed(req, allowedOrigins, ownNames)) {
            log(`http: refused a WebSocket from ${peer}, origin ${req.headers.origin}`);
            refuseUpgrade(socket, '403 Forbidden');
            return;
        }

        // Only the media endpoint agrees to the media subprotocol, which is
        // how a viewer tells it from the bridge, and from any plain proxy.
        const isMedia = url.pathname === MEDIA_PATH;
        const offered = offeredProtocols(req);
        const wantsMedia = offered.includes(MEDIA_SUBPROTOCOL);
        if (wantsMedia && !isMedia) {
            refuseUpgrade(socket, '404 Not Found');
            return;
        }
        const protocol = wantsMedia ? MEDIA_SUBPROTOCOL
            : isMedia ? null
                : offered.includes('binary') ? 'binary' : offered[0];

        const ws = acceptWebSocket(req, socket, isMedia ? MAX_MEDIA_MESSAGE : MAX_TCP_MESSAGE, protocol);
        if (!ws) return;
        if (!isMedia) {
            bridgeTcp(ws, peer);
        } else if (url.searchParams.has('probe')) {
            answerProbe(ws);
        } else {
            attachMedia(ws, peer);
        }
        ws.receive(head);
    });

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(listen, host, () => {
                server.off('error', reject);
                resolve();
            });
        });
    } catch (err) {
        await closeUdp();
        throw new Error(`cannot listen on ${host}:${listen}: ${err.code || err.message}`);
    }
    server.on('error', err => log(`http: ${err.message}`));

    const port = server.address().port;
    const boundUdp = udp.map(socket => socket.address().port);
    log(`relay: serving ${webRoot} on http://${host}:${port}/`);
    log(`relay: target ${targetHost} (${targetIp}), TCP ${targetPort}, UDP ${boundUdp.join(' and ')}`);

    let closing = null;
    function close() {
        if (!closing) {
            clearInterval(countersTimer);
            const closed = new Promise(resolve => server.close(resolve));
            for (const socket of sockets) socket.destroy();
            for (const socket of targets) socket.destroy();
            closing = Promise.all([closed, closeUdp()]).then(() => {});
        }
        return closing;
    }

    return { port, udpLocalPorts: boundUdp, close };
}

// ===================================================================
//  Command line
// ===================================================================

function parsePort(text, what) {
    const port = Number(text);
    if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
        throw new Error(`${what}: "${text}" is not a port number`);
    }
    return port;
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (!['--listen', '--target', '--web', '--host', '--allow-origin'].includes(flag)) {
            throw new Error(`unknown argument ${flag}`);
        }
        if (value === undefined) throw new Error(`${flag} needs a value`);

        if (flag === '--listen') {
            options.listen = parsePort(value, flag);
        } else if (flag === '--target') {
            const parts = /^([^:]+)(?::([^:]*))?$/.exec(value);
            if (!parts) throw new Error(`--target: "${value}" is not HOST or HOST:PORT`);
            options.targetHost = parts[1];
            if (parts[2] !== undefined) options.targetPort = parsePort(parts[2], flag);
        } else if (flag === '--web') {
            options.web = value;
        } else if (flag === '--allow-origin') {
            let origin;
            try {
                origin = new URL(value).origin;
            } catch {
                origin = 'null';
            }
            if (origin === 'null') throw new Error(`--allow-origin: "${value}" is not an origin like https://host:port`);
            (options.allowOrigins = options.allowOrigins || []).push(origin);
        } else {
            options.host = value;
        }
    }
    if (options.listen === undefined) throw new Error('--listen is required');
    if (options.targetHost === undefined) throw new Error('--target is required');
    return options;
}

async function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
        return;
    }
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        console.error(`relay: ${err.message}\n\n${USAGE}`);
        process.exit(2);
    }
    try {
        const relay = await startRelay(options);
        const stop = () => relay.close().then(() => process.exit(0));
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    } catch (err) {
        console.error(`relay: ${err.message}`);
        process.exit(1);
    }
}

function isEntryPoint() {
    try {
        return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isEntryPoint()) main(process.argv.slice(2));
