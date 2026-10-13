/*
 * Unit tests for the virtual display that follows the viewer's window.
 *
 * Run: node --test ard/tests/test.display-follow.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';

import { DisplayFollower, RESIZE_SETTLE_MS, RESIZE_MIN_CHANGE, DISPLAY_ANSWER_MS } from '../display-follow.js';

function mode(width, height) {
    return { width, height, pixelWidth: width, pixelHeight: height };
}

describe('Display that follows the window', () => {
    let win, connected, connecting, reconnects, silent, follower;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
        win = mode(1600, 900);
        connected = true;
        connecting = false;
        reconnects = [];
        silent = [];
        follower = new DisplayFollower({
            wanted: () => win,
            connected: () => connected,
            connecting: () => connecting,
            reconnect: m => reconnects.push(m),
            onSilent: m => silent.push(m),
        });
    });

    afterEach(() => mock.timers.reset());

    // A session that asked for the window's size and was answered
    function session() {
        follower.requested(win);
        follower.answered();
    }

    it('has sensible limits', () => {
        strictEqual(RESIZE_SETTLE_MS >= 1000 && RESIZE_SETTLE_MS <= 2000, true);
        strictEqual(RESIZE_MIN_CHANGE >= 16, true);
        strictEqual(DISPLAY_ANSWER_MS >= 5000, true);
    });

    it('reconnects once the window has stopped changing', () => {
        session();
        win = mode(1400, 800);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS - 1);
        deepStrictEqual(reconnects, []);
        mock.timers.tick(1);
        deepStrictEqual(reconnects, [mode(1400, 800)]);
    });

    it('waits through a drag: every change starts the wait again', () => {
        session();
        for (let w = 1590; w >= 1200; w -= 10) {
            win = mode(w, 900);
            follower.resized();
            mock.timers.tick(100);
        }
        deepStrictEqual(reconnects, [], 'nothing while it is moving');
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects, [mode(1200, 900)], 'one reconnect, for the final size');
    });

    it('ignores a change of a few points', () => {
        session();
        win = mode(1600 - (RESIZE_MIN_CHANGE - 1), 900 + (RESIZE_MIN_CHANGE - 1));
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects, []);
    });

    it('follows a change in one direction alone', () => {
        session();
        win = mode(1600, 900 - RESIZE_MIN_CHANGE);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects, [mode(1600, 900 - RESIZE_MIN_CHANGE)]);
    });

    it('does nothing when the window comes back to the size asked for', () => {
        session();
        win = mode(1200, 700);
        follower.resized();
        mock.timers.tick(500);
        win = mode(1600, 900);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects, []);
    });

    it('does nothing in a session that asked for no size', () => {
        win = mode(1200, 700);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS * 3);
        deepStrictEqual(reconnects, []);
    });

    it('does nothing when no size is wanted any more', () => {
        session();
        win = null;
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects, []);
    });

    it('reconnects once for one change, however often it is told', () => {
        session();
        win = mode(1300, 700);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        strictEqual(reconnects.length, 1);
    });

    it('follows up a change that came while it was reconnecting', () => {
        session();
        win = mode(1300, 700);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS);
        strictEqual(reconnects.length, 1);

        // The old connection goes; the new one is being made for 1300x700
        follower.closed();
        connected = false;
        connecting = true;
        win = mode(1000, 600);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS * 2);
        strictEqual(reconnects.length, 1, 'not while connecting');

        // It comes up, having asked for the size of a moment ago
        connected = true;
        connecting = false;
        follower.requested(mode(1300, 700));
        follower.answered();
        mock.timers.tick(RESIZE_SETTLE_MS);
        deepStrictEqual(reconnects[1], mode(1000, 600));
    });

    it('stops looking when nothing is connecting', () => {
        session();
        follower.closed();
        connected = false;
        win = mode(1000, 600);
        follower.resized();
        mock.timers.tick(RESIZE_SETTLE_MS * 10);
        deepStrictEqual(reconnects, []);
    });

    it('reports a server that does not answer a request', () => {
        follower.requested(mode(1600, 900));
        mock.timers.tick(DISPLAY_ANSWER_MS - 1);
        deepStrictEqual(silent, []);
        mock.timers.tick(1);
        deepStrictEqual(silent, [mode(1600, 900)]);
    });

    it('does not report one that answers, or a connection that ends first', () => {
        follower.requested(mode(1600, 900));
        mock.timers.tick(400);
        follower.answered();
        mock.timers.tick(DISPLAY_ANSWER_MS);

        follower.requested(mode(1600, 900));
        follower.closed();
        mock.timers.tick(DISPLAY_ANSWER_MS);
        deepStrictEqual(silent, []);
    });
});
