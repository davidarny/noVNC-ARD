/*
 * Unit tests for the High Performance virtual display request (0x1d).
 *
 * Run: node --test ard/tests/test.hp-virtual-display.js
 */

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert';

import {
    buildVirtualDisplayMessage, DEFAULT_VIRTUAL_DISPLAY, virtualDisplayFor, parseDisplayRequest,
} from '../hp/virtual-display.js';

// The message Apple's viewer sends for one virtual display.
const REFERENCE =
    '1d0001300001000100000000012853637265656e2053686172696e67205669727475616c20446973706c6179' +
    '00'.repeat(98) +
    '43b8ba2f434fd17400000f000000087000000000000000070005' +
    '00000f00000008700000078000000438404e000000000000' + '00000000' +
    '00000b4000000708000005a000000384404e000000000000' + '00000000' +
    '00000f00000008700000078000000438404e000000000000' + '00000000' +
    '00000b4000000654000005a00000032a404e000000000000' + '00000000' +
    '00000a40000006a00000052000000350404e000000000000' + '00000000';

describe('Virtual display request', () => {
    it('reproduces the reference message byte for byte', () => {
        const msg = buildVirtualDisplayMessage();
        strictEqual(msg.length, 308);
        strictEqual(Buffer.from(msg).toString('hex'), REFERENCE);
    });

    it('sizes the message and its records from the mode count', () => {
        const one = { name: 'A', modes: [{ pixelWidth: 2560, pixelHeight: 1440, width: 1280, height: 720, refresh: 60 }] };
        const msg = buildVirtualDisplayMessage([one]);
        const view = new DataView(msg.buffer);
        strictEqual(msg.length, 12 + 156 + 28);
        strictEqual(view.getUint16(2), msg.length - 4);
        strictEqual(view.getUint16(6), 1);
        strictEqual(view.getUint16(12), 156 + 28);
        strictEqual(view.getUint32(12 + 138), 2560);
        strictEqual(view.getUint32(12 + 142), 1440);
        strictEqual(view.getUint16(12 + 154), 1);
        strictEqual(view.getFloat64(12 + 156 + 16), 60);
    });

    it('carries two displays', () => {
        const msg = buildVirtualDisplayMessage([DEFAULT_VIRTUAL_DISPLAY, DEFAULT_VIRTUAL_DISPLAY]);
        const view = new DataView(msg.buffer);
        strictEqual(msg.length, 12 + 296 * 2);
        strictEqual(view.getUint16(6), 2);
        strictEqual(view.getUint16(12 + 296), 296);
    });

    it('rejects a display with no modes or an unusable name', () => {
        throws(() => buildVirtualDisplayMessage([{ name: 'A', modes: [] }]));
        throws(() => buildVirtualDisplayMessage([{ name: 'x'.repeat(128), modes: DEFAULT_VIRTUAL_DISPLAY.modes }]));
        throws(() => buildVirtualDisplayMessage([{ name: 'café', modes: DEFAULT_VIRTUAL_DISPLAY.modes }]));
    });
});

describe('Virtual display of a chosen size', () => {
    const mode = d => d.modes[0];

    it('asks for the size in points and the pixels that go with the scale', () => {
        deepStrictEqual(virtualDisplayFor({ width: 1920, height: 1080, scale: 2 }).modes, [
            { pixelWidth: 3840, pixelHeight: 2160, width: 1920, height: 1080, refresh: 60 }]);
        deepStrictEqual(virtualDisplayFor({ width: 1920, height: 1080, scale: 1 }).modes, [
            { pixelWidth: 1920, pixelHeight: 1080, width: 1920, height: 1080, refresh: 60 }]);
        // scale 2 when none is given, and Apple's name for the display
        strictEqual(mode(virtualDisplayFor({ width: 1440, height: 900 })).pixelWidth, 2880);
        strictEqual(virtualDisplayFor({ width: 1440, height: 900 }).name, DEFAULT_VIRTUAL_DISPLAY.name);
    });

    it('gives the same first mode as Apple for 1920x1080 at 2', () => {
        deepStrictEqual(mode(virtualDisplayFor({ width: 1920, height: 1080, scale: 2 })),
                        DEFAULT_VIRTUAL_DISPLAY.modes[0]);
    });

    it('keeps the picture within the pixels of 3840x2160, in the same shape', () => {
        const m = mode(virtualDisplayFor({ width: 2560, height: 1440, scale: 2 }));
        deepStrictEqual([m.pixelWidth, m.pixelHeight, m.width, m.height], [3840, 2160, 1920, 1080]);
        const big = mode(virtualDisplayFor({ width: 5120, height: 2880, scale: 1 }));
        deepStrictEqual([big.pixelWidth, big.pixelHeight], [3840, 2160]);
    });

    // The limit is the number of pixels, not a width and a height
    it('lets a shape that is not 16 to 9 be wider than 3840 or taller than 2160', () => {
        const tall = mode(virtualDisplayFor({ width: 1200, height: 1600, scale: 2 }));
        deepStrictEqual([tall.pixelWidth, tall.pixelHeight, tall.width, tall.height], [2400, 3200, 1200, 1600]);
        const wide = mode(virtualDisplayFor({ width: 2000, height: 600, scale: 2 }));
        deepStrictEqual([wide.pixelWidth, wide.pixelHeight, wide.width, wide.height], [4000, 1200, 2000, 600]);
        // and makes room for it in the display
        deepStrictEqual(virtualDisplayFor({ width: 2000, height: 600, scale: 2 }).largest,
                        { pixelWidth: 4000, pixelHeight: 2160 });
        deepStrictEqual(virtualDisplayFor({ width: 1200, height: 1600, scale: 2 }).largest,
                        { pixelWidth: 3840, pixelHeight: 3200 });
    });

    it('never makes a side longer than 7680 pixels', () => {
        const strip = mode(virtualDisplayFor({ width: 5000, height: 480, scale: 2 }));
        deepStrictEqual([strip.pixelWidth, strip.width], [7680, 3840]);
    });

    it('makes every dimension even', () => {
        const odd = mode(virtualDisplayFor({ width: 1365, height: 767, scale: 1 }));
        deepStrictEqual([odd.width, odd.height, odd.pixelWidth, odd.pixelHeight], [1366, 768, 1366, 768]);
    });

    // A Mac marks a smaller mode "unsupported" and uses 800x600 at 2 instead:
    // seen for 1478x480 at 2. At 1 it took 1478x480.
    it('asks for nothing smaller than a Mac will show, keeping the shape', () => {
        const short2 = mode(virtualDisplayFor({ width: 1478, height: 480, scale: 2 }));
        deepStrictEqual([short2.width, short2.height, short2.pixelWidth, short2.pixelHeight],
                        [1662, 540, 3324, 1080]);
        const short1 = mode(virtualDisplayFor({ width: 1478, height: 480, scale: 1 }));
        deepStrictEqual([short1.width, short1.height], [1478, 480]);
        const small2 = mode(virtualDisplayFor({ width: 320, height: 240, scale: 2 }));
        deepStrictEqual([small2.width, small2.height, small2.pixelWidth, small2.pixelHeight], [800, 600, 1600, 1200]);
        const small1 = mode(virtualDisplayFor({ width: 320, height: 240, scale: 1 }));
        deepStrictEqual([small1.width, small1.height], [800, 600]);
    });

    // A window 1950 points wide and 480 high at 2 was sent as 3840 pixels for
    // 1950 points: the server made a display of 1600x1200 instead.
    it('always sends pixels that are the points times the scale', () => {
        for (const scale of [1, 2]) {
            for (const [width, height] of [[1950, 480], [1976, 490], [3000, 300], [300, 3000], [641, 479],
                                           [5000, 400], [400, 5000], [1921, 1081], [974, 784]]) {
                const m = mode(virtualDisplayFor({ width, height, scale }));
                deepStrictEqual([m.pixelWidth, m.pixelHeight], [m.width * scale, m.height * scale],
                                `${width}x${height}@${scale}`);
                strictEqual(m.pixelWidth * m.pixelHeight <= 3840 * 2160 &&
                            m.pixelWidth <= 7680 && m.pixelHeight <= 7680, true, `${width}x${height}@${scale}`);
            }
        }
    });

    it('refuses a size that is not one', () => {
        throws(() => virtualDisplayFor({ width: 0, height: 1080 }));
        throws(() => virtualDisplayFor({ width: 1920, height: NaN }));
        throws(() => virtualDisplayFor({ width: 1920, height: 1080, scale: 0 }));
    });

    it('builds a message of one mode from it', () => {
        const msg = buildVirtualDisplayMessage([virtualDisplayFor({ width: 1600, height: 900, scale: 2 })]);
        const view = new DataView(msg.buffer);
        strictEqual(msg.length, 12 + 156 + 28);
        strictEqual(view.getUint16(12 + 154), 1);
        deepStrictEqual([0, 4, 8, 12].map(o => view.getUint32(12 + 156 + o)), [3200, 1800, 1600, 900]);
    });

    // A display is never later made wider or taller than the largest size
    // it was made with, so it is made with room for any size asked for here.
    it('makes the display with room for the largest picture, whatever its first size', () => {
        for (const size of [{ width: 1600, height: 900, scale: 2 }, { width: 1618, height: 762, scale: 1 }]) {
            const display = virtualDisplayFor(size);
            deepStrictEqual(display.largest, { pixelWidth: 3840, pixelHeight: 2160 });
            const view = new DataView(buildVirtualDisplayMessage([display]).buffer);
            deepStrictEqual([view.getUint32(12 + 138), view.getUint32(12 + 142)], [3840, 2160]);
        }
    });

    it('never states a largest size smaller than one of its modes', () => {
        const display = {
            name: 'A', largest: { pixelWidth: 1000, pixelHeight: 3000 },
            modes: [{ pixelWidth: 2560, pixelHeight: 1440, width: 1280, height: 720, refresh: 60 }],
        };
        const view = new DataView(buildVirtualDisplayMessage([display]).buffer);
        deepStrictEqual([view.getUint32(12 + 138), view.getUint32(12 + 142)], [2560, 3000]);
    });
});

describe('Display size as text', () => {
    const viewport = { width: 1512.4, height: 861.6, scale: 2 };

    it('reads points, with the scale when given', () => {
        deepStrictEqual(parseDisplayRequest('1920x1080'), { width: 1920, height: 1080, scale: 2 });
        deepStrictEqual(parseDisplayRequest('2560X1440@1'), { width: 2560, height: 1440, scale: 1 });
        deepStrictEqual(parseDisplayRequest('1280x720@2'), { width: 1280, height: 720, scale: 2 });
    });

    it('takes the window for "window", at one pixel to the point on any screen', () => {
        deepStrictEqual(parseDisplayRequest('window', viewport), { width: 1512, height: 862, scale: 1 });
        deepStrictEqual(parseDisplayRequest('Window', { width: 1280, height: 700, scale: 1 }),
                        { width: 1280, height: 700, scale: 1 });
        deepStrictEqual(parseDisplayRequest('window', { width: 1280, height: 700 }).scale, 1);
    });

    it('takes the window at a stated scale for "window@2"', () => {
        deepStrictEqual(parseDisplayRequest('window@2', { width: 1280, height: 700, scale: 1 }),
                        { width: 1280, height: 700, scale: 2 });
        deepStrictEqual(parseDisplayRequest('WINDOW@1', viewport), { width: 1512, height: 862, scale: 1 });
        strictEqual(parseDisplayRequest('window@3', viewport), null);
        strictEqual(parseDisplayRequest('window@', viewport), null);
    });

    it('returns null for anything else', () => {
        for (const text of ['', '1920', '1920x', 'x1080', '1920x1080@3', '1920x1080@', '19x10',
                            '1920*1080', ' 1920x1080', '1920x1080 ', 'auto', '1e3x1e3']) {
            strictEqual(parseDisplayRequest(text, viewport), null, JSON.stringify(text));
        }
        strictEqual(parseDisplayRequest(null, viewport), null);
        strictEqual(parseDisplayRequest(undefined, viewport), null);
        strictEqual(parseDisplayRequest('window'), null);
        strictEqual(parseDisplayRequest('window', { width: 0, height: 700, scale: 2 }), null);
    });
});
