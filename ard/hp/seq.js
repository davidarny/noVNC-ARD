/*
 * High Performance mode — counters that wrap at 16 bits.
 *
 * RTP sequence numbers and the decoding order numbers of the video
 * (ARD protocol spec, Section 14.10) are sent as 16 bits and start again
 * at 0 after 65535. Two values are compared by the shorter way round.
 *
 * SRTP has its own, slightly different rule for the same counter (the
 * rollover counter of RFC 3711, which never goes below 0); srtp.js follows
 * the RFC's wording and does not use this.
 */

const MOD = 0x10000;
const HALF = 0x8000;

// How far `to` is ahead of `from`, from -32768 to 32767. Either may be a
// 16-bit value or an already extended one.
export function seqDelta(to, from) {
    return ((to - from) % MOD + MOD + HALF) % MOD - HALF;
}

// The value nearest `reference` that the 16-bit `seq` can stand for.
// `reference` is an extended value: any integer.
export function extendSeq(reference, seq) {
    return reference + seqDelta(seq, reference);
}
