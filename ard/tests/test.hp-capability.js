/*
 * Unit tests for the choice of servers to ask for High Performance mode.
 *
 * Run: node --test ard/tests/test.hp-capability.js
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

import { offersHighPerformance } from '../hp/capability.js';

function bitmap(hex) {
    const out = new Uint8Array(16);
    out.set(hex.match(/../g).map(b => parseInt(b, 16)));
    return out;
}

describe('Servers asked for High Performance', () => {
    it('asks the servers that have sent it', () => {
        strictEqual(offersHighPerformance(bitmap('bffee72fec')), true);
        strictEqual(offersHighPerformance(bitmap('bffee72fe0')), true);
        strictEqual(offersHighPerformance(bitmap('bff6e72fec')), true);
    });

    it('does not ask an Intel Mac', () => {
        strictEqual(offersHighPerformance(bitmap('bffee723e0')), false);
    });

    it('needs both bits', () => {
        strictEqual(offersHighPerformance(bitmap('bffee727e0')), false);
        strictEqual(offersHighPerformance(bitmap('bffee72be0')), false);
        strictEqual(offersHighPerformance(bitmap('ffffff0cff')), true);
        strictEqual(offersHighPerformance(bitmap('fffffff3ff')), false);
    });

    it('does not ask a server that sent no bitmap', () => {
        strictEqual(offersHighPerformance(null), false);
        strictEqual(offersHighPerformance(undefined), false);
        strictEqual(offersHighPerformance(new Uint8Array(3)), false);
        strictEqual(offersHighPerformance(new Uint8Array(16)), false);
    });
});
