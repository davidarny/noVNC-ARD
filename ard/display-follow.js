/*
 * noVNC-ARD: a virtual display that follows the viewer's window.
 *
 * The size of a virtual display is asked for when the session is set up
 * (message 0x1d) and cannot be changed on a connection that is running, so
 * following the window means connecting again. This keeps track of what
 * was asked for and decides when that is worth doing:
 *
 *   - not while the window is still being dragged: it waits until the size
 *     has stopped changing for a while;
 *   - not for a few pixels: a scroll bar appearing, a tool bar folding;
 *   - not while a connection is being made: it looks again afterwards.
 *
 * It also watches for a server that says nothing after being asked, which
 * one did for a size it would not make: the viewer would otherwise sit in
 * front of an empty window.
 *
 * A mode is { width, height, pixelWidth, pixelHeight }, sizes in points and
 * in pixels, as virtualDisplayFor() makes them.
 */

export const RESIZE_SETTLE_MS = 1200;       // the window has stopped changing
export const RESIZE_MIN_CHANGE = 24;        // points, in either direction
export const DISPLAY_ANSWER_MS = 8000;      // the server reports a new display within half a second

export class DisplayFollower {
    /*
     * wanted():         the mode the window calls for now, or null when no
     *                   size is to be asked for
     * connected():      a session is up
     * connecting():     a connection is being made
     * reconnect(mode):  connect again; the new connection will ask for `mode`
     * onSilent(mode):   the server did not report a display after `mode` was
     *                   asked for
     */
    constructor({ wanted, connected, connecting, reconnect, onSilent,
                  settleMs = RESIZE_SETTLE_MS, minChange = RESIZE_MIN_CHANGE,
                  answerMs = DISPLAY_ANSWER_MS }) {
        this._wanted = wanted;
        this._connected = connected;
        this._connecting = connecting || (() => false);
        this._reconnect = reconnect;
        this._onSilent = onSilent || (() => {});
        this._settleMs = settleMs;
        this._minChange = minChange;
        this._answerMs = answerMs;

        this._asked = null;         // mode asked for on the current connection
        this._settle = null;
        this._answer = null;
    }

    // The viewer has asked the server for a display.
    requested(mode) {
        this._asked = mode;
        clearTimeout(this._answer);
        this._answer = setTimeout(() => {
            this._answer = null;
            this._onSilent(mode);
        }, this._answerMs);
    }

    // The server has reported its display.
    answered() {
        clearTimeout(this._answer);
        this._answer = null;
    }

    // The window has changed size.
    resized() {
        clearTimeout(this._settle);
        this._settle = setTimeout(() => this._check(), this._settleMs);
    }

    // The connection has ended.
    closed() {
        clearTimeout(this._answer);
        this._answer = null;
        this._asked = null;
        // A change of size that came during the disconnect is looked at
        // once the next connection is up: _settle stays.
    }

    _check() {
        this._settle = null;
        if (!this._connected() || !this._asked) {
            // A connection is on its way: the size it asks for may be stale
            // by the time it is up, so look again then.
            if (this._connecting() && this._wanted() !== null) {
                this._settle = setTimeout(() => this._check(), this._settleMs);
            }
            return;
        }
        const next = this._wanted();
        if (!next) return;
        if (Math.abs(next.width - this._asked.width) < this._minChange &&
            Math.abs(next.height - this._asked.height) < this._minChange) {
            return;
        }
        this._asked = null;         // one reconnect for one change
        this._reconnect(next);
    }
}
