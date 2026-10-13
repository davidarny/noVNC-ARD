/*
 * High Performance mode — contents of the media offers.
 *
 * The values are those Apple's own viewer sends (ARD protocol spec,
 * Section 14.8). Only the SSRC and the timestamp differ between sessions.
 * Most fields are not understood; they are reproduced as observed.
 *
 * A message is a list of [field, value] pairs. A value is a number, a
 * BigInt, a string, or a nested list for an embedded message.
 */

export const MEDIA_SOFTWARE = 'Viceroy 1.7.0';

// What the viewer says about itself in every offer.
export const DEFAULT_ENDPOINT = {
    model: 'Mac13,1',
    version: '2235.63.5.2',
    build: '26A428',
};

export const MODE_AUDIO = 8;
export const MODE_VIDEO = 7;

export const PAYLOAD_TYPE_HEVC = 100;
export const PAYLOAD_TYPE_H264 = 123;

const FEATURES_H264 = 'FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;SW:4;AR:8/5,5/8;XR:8/5,5/8;';
const FEATURES_HEVC = 'FLS;LF:-1;POS:5;EOD:1;HTS:2;RR:3;POSE:4;SW:0;AR:8/5,5/8;XR:8/5,5/8;';

// Field 9: the same ten entries appear in every blob.
const TABLE = [
    [4074, 0, 16384],
    [1, 299],
    [4, 6500],
    [16, 4100],
    [0, 6000000, 131072],
    [0, 20000000, 98304],
    [0, 40000000, 12288],
    [0, 60000000, 262144],
    [0, 75000000, 524288],
    [0, 100000000, 1048576],
];

function tableFields() {
    return TABLE.map(row => [9, row.map((value, i) => [i + 1, value])]);
}

function payloadEntry(payloadType, variants, features, last) {
    const fields = [[1, payloadType]];
    for (const n of variants) {
        fields.push([2, [[1, 1], [2, n], [3, 50115], [4, 0]]]);
    }
    fields.push([3, features], [4, last]);
    return fields;
}

export function endpointFields(endpoint = DEFAULT_ENDPOINT) {
    return [
        [1, 0],
        [2, 1],
        [3, endpoint.model],
        [4, endpoint.version],
        [5, endpoint.build],
    ];
}

// ntpTime: BigInt, NTP seconds in the upper 32 bits.
export function audioBlobFields({ ssrc, ntpTime }) {
    return [
        [1, 1],
        [2, 1],
        [3, [[1, ssrc], [2, 0], [3, 0], [4, 7807], [5, 0], [6, 0]]],
        [6, MEDIA_SOFTWARE],
        [8, 0],
        ...tableFields(),
        [13, ntpTime],
        [14, 2],
        [16, 0],
        [18, 1],
    ];
}

export function videoBlobFields({ ssrc, ntpTime }) {
    return [
        [1, 1],
        [2, 1],
        [5, [
            [1, ssrc],
            [2, 0],
            [3, payloadEntry(PAYLOAD_TYPE_H264, [1, 2, 1, 2], FEATURES_H264, 1)],
            [3, payloadEntry(PAYLOAD_TYPE_HEVC, [1, 2], FEATURES_HEVC, 14)],
            [6, 4],
            [7, 1],
            [8, 255],
            [9, 1],
            [12, 1],
        ]],
        [6, MEDIA_SOFTWARE],
        [8, 0],
        ...tableFields(),
        [13, ntpTime],
        [14, 2],
        [16, 0],
        [18, 1],
    ];
}
