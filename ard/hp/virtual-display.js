/*
 * High Performance mode — asking the server for a virtual display.
 *
 * Apple's viewer sends this message (type 0x1d) before SetEncodings when it
 * wants High Performance on a virtual display. The server then creates a
 * display with the modes listed, sends the video at its pixel resolution,
 * and reports its size in points. Without the message the server shares its
 * real displays.
 *
 *   0    1   0x1d
 *   1    1   0
 *   2    2   length of everything that follows
 *   4    2   1
 *   6    2   number of displays
 *   8    4   0
 *  12        one record for each display:
 *
 *   0    2   length of this record, including these two bytes
 *   2  128   name, zero padded
 * 130    4   width in millimetres  (float), at 132 points to the inch
 * 134    4   height in millimetres (float)
 * 138    4   largest width in pixels
 * 142    4   largest height in pixels
 * 146    6   0
 * 152    2   7
 * 154    2   number of modes
 * 156        28 bytes for each mode:
 *              4   width in pixels      4   height in pixels
 *              4   width in points      4   height in points
 *              8   refresh rate in Hz (double)
 *              4   0
 *
 * The meaning of the constants 1 and 7 is not known; they are sent as
 * observed.
 */

export const MSG_VIRTUAL_DISPLAY = 0x1d;

const NAME_LENGTH = 128;
const MODE_LENGTH = 28;
const POINTS_PER_INCH = 132;

// The display Apple's viewer asks for: 1920×1080 points at 2×, with the
// alternative modes it offers.
export const DEFAULT_VIRTUAL_DISPLAY = {
    name: 'Screen Sharing Virtual Display',
    modes: [
        { pixelWidth: 3840, pixelHeight: 2160, width: 1920, height: 1080, refresh: 60 },
        { pixelWidth: 2880, pixelHeight: 1800, width: 1440, height: 900, refresh: 60 },
        { pixelWidth: 3840, pixelHeight: 2160, width: 1920, height: 1080, refresh: 60 },
        { pixelWidth: 2880, pixelHeight: 1620, width: 1440, height: 810, refresh: 60 },
        { pixelWidth: 2624, pixelHeight: 1696, width: 1312, height: 848, refresh: 60 },
    ],
};

// The largest picture a server has been seen to send.
const MAX_PIXEL_WIDTH = 3840;
const MAX_PIXEL_HEIGHT = 2160;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

/*
 * A display of one mode: `width` × `height` points, drawn at `scale` pixels
 * to the point (2 is what Apple calls HiDPI). The size is brought within
 * what servers are known to send, keeping its shape, and the pixel
 * dimensions are made even, as video needs.
 */
export function virtualDisplayFor({ width, height, scale = 2 }) {
    if (!(width > 0 && height > 0 && scale > 0)) throw new Error('virtual display: bad size');
    const fit = Math.min(1, MAX_PIXEL_WIDTH / (width * scale), MAX_PIXEL_HEIGHT / (height * scale));
    const grow = Math.max(1, MIN_WIDTH / (width * fit), MIN_HEIGHT / (height * fit));
    const even = v => Math.max(2, Math.round(v / 2) * 2);
    const w = even(width * fit * grow);
    const h = even(height * fit * grow);
    return {
        name: DEFAULT_VIRTUAL_DISPLAY.name,
        modes: [{
            pixelWidth: Math.min(MAX_PIXEL_WIDTH, even(w * scale)),
            pixelHeight: Math.min(MAX_PIXEL_HEIGHT, even(h * scale)),
            width: w, height: h, refresh: 60,
        }],
    };
}

/*
 * What a person asks for, as text: "1920x1080" (points, at 2 pixels to the
 * point), "2560x1440@1" (with the scale) or "window" (the size given as
 * `viewport`: { width, height, scale }). Returns { width, height, scale },
 * or null when the text is none of these.
 */
export function parseDisplayRequest(text, viewport) {
    if (typeof text !== 'string') return null;
    if (text.toLowerCase() === 'window') {
        if (!viewport || !(viewport.width > 0 && viewport.height > 0)) return null;
        return {
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            scale: viewport.scale >= 1.5 ? 2 : 1,
        };
    }
    const m = /^(\d{3,5})x(\d{3,5})(?:@([12]))?$/i.exec(text);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]), scale: m[3] ? Number(m[3]) : 2 };
}

function displayRecord(display) {
    const modes = display.modes;
    if (!modes || modes.length === 0) throw new Error('virtual display: no modes');
    const name = Array.from(display.name, c => c.charCodeAt(0));
    if (name.length >= NAME_LENGTH || name.some(c => c > 0x7e || c < 0x20)) {
        throw new Error('virtual display: bad name');
    }

    const length = 2 + NAME_LENGTH + 26 + modes.length * MODE_LENGTH;
    const record = new Uint8Array(length);
    const view = new DataView(record.buffer);
    const first = modes[0];
    const maxWidth = Math.max(...modes.map(m => m.pixelWidth));
    const maxHeight = Math.max(...modes.map(m => m.pixelHeight));

    view.setUint16(0, length);
    record.set(name, 2);
    let o = 2 + NAME_LENGTH;
    view.setFloat32(o, first.width * 25.4 / POINTS_PER_INCH);
    view.setFloat32(o + 4, first.height * 25.4 / POINTS_PER_INCH);
    view.setUint32(o + 8, maxWidth);
    view.setUint32(o + 12, maxHeight);
    view.setUint16(o + 22, 7);
    view.setUint16(o + 24, modes.length);
    o += 26;
    for (const m of modes) {
        view.setUint32(o, m.pixelWidth);
        view.setUint32(o + 4, m.pixelHeight);
        view.setUint32(o + 8, m.width);
        view.setUint32(o + 12, m.height);
        view.setFloat64(o + 16, m.refresh);
        o += MODE_LENGTH;
    }
    return record;
}

// The whole message, for one or more virtual displays.
export function buildVirtualDisplayMessage(displays = [DEFAULT_VIRTUAL_DISPLAY]) {
    const records = displays.map(displayRecord);
    const body = records.reduce((n, r) => n + r.length, 0);
    const msg = new Uint8Array(12 + body);
    const view = new DataView(msg.buffer);
    msg[0] = MSG_VIRTUAL_DISPLAY;
    view.setUint16(2, msg.length - 4);
    view.setUint16(4, 1);
    view.setUint16(6, displays.length);
    let o = 12;
    for (const r of records) {
        msg.set(r, o);
        o += r.length;
    }
    return msg;
}
