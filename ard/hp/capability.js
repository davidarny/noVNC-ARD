/*
 * High Performance mode — which servers to ask.
 *
 * Apple's viewers decide from the server's ServerInit, before they send
 * anything of their own, and never ask an Intel Mac. The capability bitmap
 * in ServerInit (ARD protocol spec, Section 5.2) is what separates the
 * servers seen so far:
 *
 *   bf fe e7 2f ..   every Mac that sent the mode as this viewer reads it
 *   bf fe e7 23 ..   an Intel Mac
 *
 * An Intel Mac asked anyway does enter the mode, sending another video
 * format, but not dependably, and it keeps the display it made for the
 * session afterwards. This viewer follows Apple's and does not ask.
 *
 * The meaning of the two bits is an observation from few servers, not a
 * documented fact.
 */

const BYTE = 3;
const BITS = 0x0c;

// bitmap: the 16 bytes from ServerInit, or null when the server sent none.
export function offersHighPerformance(bitmap) {
    return !!bitmap && bitmap.length > BYTE && (bitmap[BYTE] & BITS) === BITS;
}
