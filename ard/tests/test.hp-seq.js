/*
 * Unit tests for 16-bit counters that wrap.
 *
 * Run: node --test ard/tests/test.hp-seq.js
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

import { seqDelta, extendSeq } from '../hp/seq.js';

describe('Wrapping counters', () => {
    it('measures the shorter way round', () => {
        strictEqual(seqDelta(5, 5), 0);
        strictEqual(seqDelta(6, 5), 1);
        strictEqual(seqDelta(5, 6), -1);
        strictEqual(seqDelta(0, 65535), 1);
        strictEqual(seqDelta(65535, 0), -1);
        strictEqual(seqDelta(3, 65530), 9);
        strictEqual(seqDelta(65530, 3), -9);
        strictEqual(seqDelta(32767, 0), 32767);
        strictEqual(seqDelta(0, 32768), -32768);
    });

    it('takes extended values on either side', () => {
        strictEqual(seqDelta(2, 65536 * 7 + 65535), 3);
        strictEqual(seqDelta(65536 * 7 + 2, 65535), 3);
        strictEqual(seqDelta(65535, -1), 0);
        strictEqual(seqDelta(0, -3), 3);
    });

    it('extends a value to the one nearest the reference', () => {
        strictEqual(extendSeq(100, 101), 101);
        strictEqual(extendSeq(100, 99), 99);
        strictEqual(extendSeq(65535, 0), 65536);
        strictEqual(extendSeq(65536, 65535), 65535);
        strictEqual(extendSeq(65536 * 3 + 10, 12), 65536 * 3 + 12);
        strictEqual(extendSeq(65536 * 3 + 10, 65530), 65536 * 3 - 6);
    });

    it('works past 32 bits, where bit operations would not', () => {
        const far = 2 ** 40 + 65535;
        strictEqual(extendSeq(far, 1), 2 ** 40 + 65537);
        strictEqual(extendSeq(far, 65534), 2 ** 40 + 65534);
    });

    it('goes below zero for a value before the first one seen', () => {
        strictEqual(extendSeq(2, 65535), -1);
    });
});
