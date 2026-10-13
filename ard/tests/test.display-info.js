/*
 * noVNC-ARD: DisplayInfo2 payload and display selection tests.
 *
 * Run: node --test ard/tests/test.display-info.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';

import { ALL_DISPLAYS, parseDisplayInfo2, setDisplayBytes,
         displayMenuEntries, mainDisplay,
         reconcileSelection } from '../display-info.js';

function hex(s) {
    const bytes = s.replace(/\s+/g, '').match(/.{2}/g);
    return new Uint8Array(bytes.map(b => parseInt(b, 16)));
}

// Two 1920x1080 displays combined into 3840x1535. The main display is
// drawn on the right, 455 pixels down; the other one on the left.
const TWO_DISPLAYS = hex(`
    0005 0f00 05ff 0f00 05ff ffffffff 0000000c 0002
    3ff0000000000000 3ff0000000000000 00000003
    0000 0000 0438 0780   01c7 0780 05ff 0f00
    00000001 2020000100ff00ff00ff100800000000
    3ff0000000000000 3ff0000000000000 00000005
    fe39 f880 0271 0000   0000 0000 0438 0780
    00000000 2020000100ff00ff00ff100800000000`);

describe('DisplayInfo2', () => {
    it('reads the framebuffer the server is sending', () => {
        const info = parseDisplayInfo2(TWO_DISPLAYS);
        strictEqual(info.width, 3840);
        strictEqual(info.height, 1535);
        strictEqual(info.displayId, ALL_DISPLAYS);
    });

    it('reads where each display is', () => {
        const info = parseDisplayInfo2(TWO_DISPLAYS);
        deepStrictEqual(info.displays, [
            { id: 3, main: true, scale: 1,
              x: 0, y: 0, fbX: 1920, fbY: 455, w: 1920, h: 1080 },
            { id: 5, main: false, scale: 1,
              x: -1920, y: -455, fbX: 0, fbY: 0, w: 1920, h: 1080 },
        ]);
    });

    it('ignores a display entry that is cut short', () => {
        const info = parseDisplayInfo2(TWO_DISPLAYS.subarray(0, 20 + 56 + 10));
        strictEqual(info.displays.length, 1);
    });

    it('rejects a payload without a full header', () => {
        strictEqual(parseDisplayInfo2(TWO_DISPLAYS.subarray(0, 19)), null);
    });
});

describe('SetDisplay', () => {
    it('asks for all displays combined', () => {
        deepStrictEqual(setDisplayBytes(null),
                        hex('0d 01 0000 00000000'));
    });

    it('asks for one display', () => {
        deepStrictEqual(setDisplayBytes(5),
                        hex('0d 00 0000 00000005'));
    });
});

describe('display menu', () => {
    it('lists the combined view, then displays left to right', () => {
        const info = parseDisplayInfo2(TWO_DISPLAYS);
        deepStrictEqual(displayMenuEntries(info.displays), [
            { id: null, label: 'All Displays' },
            { id: 5, label: 'Display 1 · 1920 × 1080' },
            { id: 3, label: 'Display 2 · 1920 × 1080 · Main' },
        ]);
    });

    it('is empty with fewer than two displays', () => {
        const info = parseDisplayInfo2(TWO_DISPLAYS);
        deepStrictEqual(displayMenuEntries(info.displays.slice(0, 1)), []);
        deepStrictEqual(displayMenuEntries([]), []);
    });
});

describe('main display', () => {
    const displays = parseDisplayInfo2(TWO_DISPLAYS).displays;

    it('is the one the server marks as main', () => {
        strictEqual(mainDisplay(displays), 3);
    });

    it('is not chosen when there is only one display', () => {
        strictEqual(mainDisplay(displays.slice(0, 1)), null);
    });

    it('is not chosen unless exactly one display is marked', () => {
        strictEqual(mainDisplay(displays.map(d => ({ ...d, main: false }))), null);
        strictEqual(mainDisplay(displays.map(d => ({ ...d, main: true }))), null);
    });
});

describe('display selection', () => {
    const displays = parseDisplayInfo2(TWO_DISPLAYS).displays;
    const one = displays.slice(0, 1);
    const MAIN = { main: true, rank: 0 };
    const OTHER = { main: false, rank: 0 };
    // What locking the screen does: same displays, new ids
    const renumbered = displays.map(d => ({ ...d, id: d.id + 6 }));

    it('starts on the main display', () => {
        deepStrictEqual(reconcileSelection(displays, null, null, false, true),
                        { selected: 3, role: MAIN, decided: true });
    });

    it('starts on all displays when asked to', () => {
        deepStrictEqual(reconcileSelection(displays, null, null, false, false),
                        { selected: null, role: null, decided: true });
    });

    it('waits for a list with several displays before choosing', () => {
        deepStrictEqual(reconcileSelection([], null, null, false, true),
                        { selected: null, role: null, decided: false });
        deepStrictEqual(reconcileSelection(one, null, null, false, true),
                        { selected: null, role: null, decided: false });
    });

    it('chooses only once', () => {
        // The user went back to all displays, or picked the other one
        deepStrictEqual(reconcileSelection(displays, null, null, true, true),
                        { selected: null, role: null, decided: true });
        deepStrictEqual(reconcileSelection(displays, 5, null, true, true),
                        { selected: 5, role: OTHER, decided: true });
    });

    it('follows the selected display when ids change', () => {
        deepStrictEqual(reconcileSelection(renumbered, 3, MAIN, true, false),
                        { selected: 9, role: MAIN, decided: true });
        deepStrictEqual(reconcileSelection(renumbered, 5, OTHER, true, true),
                        { selected: 11, role: OTHER, decided: true });
        // and back again
        deepStrictEqual(reconcileSelection(displays, 11, OTHER, true, true),
                        { selected: 5, role: OTHER, decided: true });
    });

    it('stays on all displays when ids change', () => {
        deepStrictEqual(reconcileSelection(renumbered, null, null, true, true),
                        { selected: null, role: null, decided: true });
    });

    it('chooses again when the selected display has no counterpart', () => {
        const three = [...displays, { ...displays[1], id: 7, x: -3840 }];
        const FAR = { main: false, rank: 1 };
        deepStrictEqual(reconcileSelection(renumbered, 5, FAR, true, true),
                        { selected: 9, role: MAIN, decided: true });
        deepStrictEqual(reconcileSelection(renumbered, 5, FAR, true, false),
                        { selected: null, role: null, decided: true });
        // sanity: the role is real in a three-display list
        deepStrictEqual(reconcileSelection(three, 5, null, true, true).role, FAR);
    });

    it('falls back to all displays when only one is left', () => {
        deepStrictEqual(reconcileSelection(one, 5, OTHER, true, true),
                        { selected: null, role: null, decided: false });
    });
});
