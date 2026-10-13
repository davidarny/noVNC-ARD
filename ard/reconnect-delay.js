/*
 * How long to wait before connecting again after a connection is lost.
 *
 * A session on a virtual display waits longer. A Mac takes over a second to
 * take such a session down after the viewer leaves, and when the user logs
 * out of it, some seconds more to dispose of the login session. A request
 * for a virtual display that arrived 1.2 s after a logout, while that was
 * going on, was followed by the Mac's window server crashing (macOS 27.0.1,
 * seen once).
 */

const DELAYS_MS = [500, 1000, 2000, 5000, 10000];
export const VIRTUAL_DISPLAY_MIN_MS = 6000;

// attempt: 1 for the first try after the loss. onVirtualDisplay: the lost
// session was on a virtual display.
export function reconnectDelay(attempt, onVirtualDisplay) {
    const n = Math.max(1, Math.floor(attempt) || 1);
    const delay = DELAYS_MS[Math.min(n - 1, DELAYS_MS.length - 1)];
    return onVirtualDisplay ? Math.max(delay, VIRTUAL_DISPLAY_MIN_MS) : delay;
}
