/*
 * noVNC-ARD: display list (DisplayInfo2) and display selection (SetDisplay).
 *
 * Kept free of browser dependencies so it can be tested on its own.
 */

// Display id a server reports while it sends all displays combined
export const ALL_DISPLAYS = 0xFFFFFFFF;

const HEADER_SIZE = 20;
const ENTRY_SIZE = 56;

// DisplayInfo2 payload (pseudo-encoding 1105 and message 0x51), without
// its 2-byte size prefix:
//
//   [u16 version][u16 width][u16 height][u16 pixelWidth][u16 pixelHeight]
//   [u32 displayId][u32 flags][u16 displayCount]
//   then per display, 56 bytes:
//   [f64 backingScale][f64 displayScale][u32 displayId]
//   [i16 top][i16 left][i16 bottom][i16 right]    position on the desktop
//   [i16 top][i16 left][i16 bottom][i16 right]    position in the framebuffer
//                                                 with all displays combined
//   [u32 flags (bit 0 = main display)][16 bytes pixel format]
//
// Returns null if the header is incomplete.
export function parseDisplayInfo2(data) {
    if (data.length < HEADER_SIZE) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.length);

    const info = {
        version: view.getUint16(0),
        width: view.getUint16(6),
        height: view.getUint16(8),
        displayId: view.getUint32(10),
        flags: view.getUint32(14),
        displays: [],
    };

    const count = Math.min(view.getUint16(18),
                           Math.floor((data.length - HEADER_SIZE) / ENTRY_SIZE));
    for (let i = 0; i < count; i++) {
        const at = HEADER_SIZE + i * ENTRY_SIZE;
        const fbTop = view.getInt16(at + 28);
        const fbLeft = view.getInt16(at + 30);
        info.displays.push({
            id: view.getUint32(at + 16),
            main: (view.getUint32(at + 36) & 1) !== 0,
            scale: view.getFloat64(at),
            x: view.getInt16(at + 22),
            y: view.getInt16(at + 20),
            fbX: fbLeft,
            fbY: fbTop,
            w: view.getInt16(at + 34) - fbLeft,
            h: view.getInt16(at + 32) - fbTop,
        });
    }

    return info;
}

// SetDisplay (0x0d): [type][u8 combineAll][2 pad][u32 displayId].
// displayId null asks for all displays combined.
export function setDisplayBytes(displayId) {
    const bytes = new Uint8Array(8);
    bytes[0] = 0x0d;
    if (displayId === null) {
        bytes[1] = 1;
    } else {
        new DataView(bytes.buffer).setUint32(4, displayId);
    }
    return bytes;
}

// Entries for a display menu: the combined view, then each display in the
// order they appear in the combined picture. Empty when there is nothing
// to choose between.
export function displayMenuEntries(displays) {
    if (displays.length < 2) return [];
    const ordered = [...displays].sort((a, b) => a.fbX - b.fbX || a.fbY - b.fbY);
    return [
        { id: null, label: 'All Displays' },
        ...ordered.map((d, i) => ({
            id: d.id,
            label: 'Display ' + (i + 1) + ' · ' + d.w + ' × ' + d.h +
                   (d.main ? ' · Main' : ''),
        })),
    ];
}

// Id of the main display, when there are several displays and the server
// marks exactly one of them as main. Otherwise null: nothing to choose, or
// no safe choice.
export function mainDisplay(displays) {
    if (displays.length < 2) return null;
    const marked = displays.filter(d => d.main);
    return marked.length === 1 ? marked[0].id : null;
}

// Where a display sits among the others: main or not, and its place among
// the displays of that kind going left to right, top to bottom. Display
// ids change when the display setup does (locking the screen is enough),
// and this is what stays the same. Null if the list has no such display.
export function displayRole(displays, id) {
    const display = displays.find(d => d.id === id);
    if (display === undefined) return null;
    const peers = sameKind(displays, display.main);
    return { main: display.main, rank: peers.indexOf(display) };
}

// Id of the display with that role, or null if there is none.
export function displayWithRole(displays, role) {
    const display = sameKind(displays, role.main)[role.rank];
    return display === undefined ? null : display.id;
}

function sameKind(displays, main) {
    return displays.filter(d => d.main === main)
        .sort((a, b) => a.x - b.x || a.y - b.y);
}

// Which display to view once a display list has arrived.
//
//   selected  the display viewed so far (an id, or null for all combined)
//   role      that display's role in the previous list (null if none)
//   decided   whether the starting display has been chosen already
//   preferMain  start on the main display rather than on all combined
//
// A selected display whose id is gone is found again by its role. If
// there is no display in that role any more, the starting display is
// chosen again. That choice is made once, the first time there are
// several displays.
export function reconcileSelection(displays, selected, role, decided, preferMain) {
    if (selected !== null && displayRole(displays, selected) === null) {
        selected = role === null ? null : displayWithRole(displays, role);
        if (selected === null) {
            decided = false;
        }
    }
    if (!decided && displays.length > 1) {
        decided = true;
        const main = mainDisplay(displays);
        if (preferMain && main !== null) {
            selected = main;
        }
    }
    role = selected === null ? null : displayRole(displays, selected);
    return { selected, role, decided };
}
