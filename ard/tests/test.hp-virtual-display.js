/*
 * Unit tests for the High Performance virtual display request (0x1d).
 *
 * Run: node --test ard/tests/test.hp-virtual-display.js
 */

import { describe, it } from 'node:test';
import { strictEqual, throws } from 'node:assert';

import { buildVirtualDisplayMessage, DEFAULT_VIRTUAL_DISPLAY } from '../hp/virtual-display.js';

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
