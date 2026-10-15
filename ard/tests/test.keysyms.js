/*
 * noVNC-ARD: keysym tests
 *
 * Run: node --test ard/tests/test.keysyms.js
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

import keysyms from '../../noVNC/core/input/keysymdef.js';
import { ardKeysym } from '../keysyms.js';

const legacy = ch => keysyms.lookup(ch.codePointAt(0));
const unicode = ch => 0x01000000 | ch.codePointAt(0);

describe('Keysyms for the ARD server', () => {
    it('sends Unicode keysyms for characters the server dropped', () => {
        // One the server dropped from each of several scripts
        for (const ch of 'пхΓשتคテ€←ăĄ') {
            strictEqual(legacy(ch) < 0x01000000, true, ch + ' has a legacy keysym');
            strictEqual(ardKeysym(legacy(ch)), unicode(ch), ch);
        }
    });

    it('sends Unicode keysyms for every legacy keysym above Latin-1', () => {
        for (let cp = 0x0100; cp <= 0xFFFF; cp++) {
            const keysym = keysyms.lookup(cp);
            if (keysym < 0x01000000) {
                strictEqual(ardKeysym(keysym), 0x01000000 | cp, 'U+' + cp.toString(16));
            }
        }
    });

    it('leaves ASCII and Latin-1 alone', () => {
        for (const ch of 'aZ0 |~éüñÿ') {
            strictEqual(ardKeysym(legacy(ch)), ch.codePointAt(0), ch);
        }
    });

    it('leaves function keys and modifiers alone', () => {
        // Return, BackSpace, Tab, Escape, Left, F1, Shift_L, Control_L,
        // Alt_L, Super_L, KP_Enter
        for (const keysym of [0xff0d, 0xff08, 0xff09, 0xff1b, 0xff51, 0xffbe,
                              0xffe1, 0xffe3, 0xffe9, 0xffeb, 0xff8d]) {
            strictEqual(ardKeysym(keysym), keysym, '0x' + keysym.toString(16));
        }
    });

    it('leaves Unicode keysyms alone', () => {
        strictEqual(ardKeysym(unicode('п')), unicode('п'));
        strictEqual(ardKeysym(0x0101F600), 0x0101F600);
    });
});
