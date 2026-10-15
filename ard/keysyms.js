/*
 * noVNC-ARD: keysyms for Apple's Screen Sharing server (no browser dependencies)
 *
 * noVNC sends a character with its legacy X11 keysym when it has one: п as
 * 0x6d0, Γ as 0x7c3. Apple's server drops a fixed third of the legacy
 * keysyms above Latin-1, in every script (Latin-2 to 4, Greek, Cyrillic,
 * Hebrew, Arabic, Thai, kana, symbols), and accepts the Unicode keysym
 * (0x01000000 + code point) for all of them. ASCII and Latin-1 keysyms are
 * their own code points and are left alone, as are function keys and
 * modifiers, which are not characters.
 */

import keysyms from '../noVNC/core/input/keysymdef.js';

const UNICODE_KEYSYM = 0x01000000;

// Legacy keysym → Unicode keysym, for every character above Latin-1 that
// noVNC would send with a legacy keysym.
const unicodeForLegacy = new Map();
for (let codepoint = 0x0100; codepoint <= 0xFFFF; codepoint++) {
    const keysym = keysyms.lookup(codepoint);
    if (keysym < UNICODE_KEYSYM) {
        unicodeForLegacy.set(keysym, UNICODE_KEYSYM | codepoint);
    }
}

// The keysym to send to Apple's server for a keysym from noVNC
export function ardKeysym(keysym) {
    return unicodeForLegacy.get(keysym) ?? keysym;
}
