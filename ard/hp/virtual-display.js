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
 * 138    4   largest width in pixels the display will ever have
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
 *
 * The server keeps a display it has made while a viewer of that user
 * remains, and for some seconds after. A later request changes the mode of
 * that display, but never to one wider or taller in pixels than the largest
 * size it was made with: the server then gives fewer pixels than asked, or
 * keeps the old size and sends no picture.
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

// The largest picture a server has been seen to send, and to make room for
// in a display.
const MAX_PIXEL_WIDTH = 3840;
const MAX_PIXEL_HEIGHT = 2160;
// What a picture may hold: as many pixels as that one, in any shape. A
// server names its encoder's limit as pixels per second (3840 x 2160 x 60),
// not as a width and a height. No server has yet been sent a mode wider than
// 3840 pixels or taller than 2160.
const MAX_PIXELS = MAX_PIXEL_WIDTH * MAX_PIXEL_HEIGHT;
const MAX_PIXEL_SIDE = 7680;
// The smallest mode a server shows as asked. Below it the server's window
// server marks the mode "unsupported" and shows 800x600 at two pixels to the
// point instead. From its mode lists: at two, 960x540 and 800x600 are shown
// and 1478x480 and 672x541 are not; at one, 1478x480 is shown and 640x480 is
// not. The true limits lie somewhere between those.
const MIN_WIDTH = 800;
const MIN_HEIGHT = 480;
const MIN_HEIGHT_HIDPI = 540;

/*
 * A display of one mode: `width` × `height` points, drawn at `scale` pixels
 * to the point (2 is what Apple calls HiDPI). The size is brought within
 * the number of pixels above, keeping its shape, and the dimensions are made
 * even, as video needs. The pixels are always the points times the scale: a
 * server given a mode where they were not made a display of its own choosing.
 *
 * Its largest size is 3840×2160, or the mode's where that is wider or
 * taller, so that a display made for one size can be given another on a
 * later connection.
 */
export function virtualDisplayFor({ width, height, scale = 2 }) {
    if (!(width > 0 && height > 0 && scale > 0)) throw new Error('virtual display: bad size');
    const even = v => Math.max(2, Math.round(v / 2) * 2);
    const within = (w, h) => even(w * scale) * even(h * scale) <= MAX_PIXELS &&
                             even(w * scale) <= MAX_PIXEL_SIDE && even(h * scale) <= MAX_PIXEL_SIDE;
    // Not smaller than the smallest; then not more than the most, which wins
    const minHeight = scale > 1 ? MIN_HEIGHT_HIDPI : MIN_HEIGHT;
    const grow = Math.max(1, MIN_WIDTH / width, minHeight / height);
    const pw = width * grow * scale;
    const ph = height * grow * scale;
    const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (pw * ph)), MAX_PIXEL_SIDE / pw, MAX_PIXEL_SIDE / ph);
    let w = even(width * grow * fit);
    let h = even(height * grow * fit);
    // Rounding to even numbers can take it just past
    while (!within(w, h) && (w > 2 || h > 2)) {
        if (w >= h) w -= 2; else h -= 2;
    }
    const pixelWidth = even(w * scale);
    const pixelHeight = even(h * scale);
    return {
        name: DEFAULT_VIRTUAL_DISPLAY.name,
        largest: {
            pixelWidth: Math.max(MAX_PIXEL_WIDTH, pixelWidth),
            pixelHeight: Math.max(MAX_PIXEL_HEIGHT, pixelHeight),
        },
        modes: [{ pixelWidth, pixelHeight, width: w, height: h, refresh: 60 }],
    };
}

/*
 * What a person asks for, as text: "1920x1080" (points, at 2 pixels to the
 * point), "2560x1440@1" (with the scale), "window" (the size given as
 * `viewport`: { width, height }, at one pixel to the point) or "window@2"
 * (that size at two). Returns { width, height, scale }, or null when the
 * text is none of these.
 *
 * "window" asks for one pixel to the point whatever the screen, because
 * that is the request servers have honoured every time; at two they have
 * also halved the size or not answered.
 */
export function parseDisplayRequest(text, viewport) {
    if (typeof text !== 'string') return null;
    const w = /^window(?:@([12]))?$/i.exec(text);
    if (w) {
        if (!viewport || !(viewport.width > 0 && viewport.height > 0)) return null;
        return {
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            scale: w[1] ? Number(w[1]) : 1,
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
    // `largest` is optional; without it, the largest of the modes
    const largest = display.largest || { pixelWidth: 0, pixelHeight: 0 };
    const maxWidth = Math.max(largest.pixelWidth, ...modes.map(m => m.pixelWidth));
    const maxHeight = Math.max(largest.pixelHeight, ...modes.map(m => m.pixelHeight));

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
