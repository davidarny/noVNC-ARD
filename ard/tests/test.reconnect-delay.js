/*
 * Unit tests for the wait before connecting again.
 *
 * Run: node --test ard/tests/test.reconnect-delay.js
 */

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { reconnectDelay, VIRTUAL_DISPLAY_MIN_MS } from '../reconnect-delay.js';

describe('Reconnect delay', () => {
    it('backs off from half a second to ten', () => {
        deepStrictEqual([1, 2, 3, 4, 5, 6, 10].map(n => reconnectDelay(n, false)),
                        [500, 1000, 2000, 5000, 10000, 10000, 10000]);
    });

    it('gives a Mac time to take a virtual display session down', () => {
        strictEqual(VIRTUAL_DISPLAY_MIN_MS, 6000);
        deepStrictEqual([1, 2, 3, 4, 5, 6].map(n => reconnectDelay(n, true)),
                        [6000, 6000, 6000, 6000, 10000, 10000]);
    });

    it('treats an attempt that is not a count as the first', () => {
        strictEqual(reconnectDelay(0, false), 500);
        strictEqual(reconnectDelay(undefined, false), 500);
        strictEqual(reconnectDelay(NaN, true), 6000);
    });
});
