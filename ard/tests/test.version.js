/*
 * noVNC-ARD: version format test.
 *
 * The version is <noVNC-ARD version>+<bundled noVNC version>. The part
 * after the plus has to follow the noVNC submodule.
 *
 * Run: node --test ard/tests/test.version.js
 */

import { describe, it } from 'node:test';
import { match, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';

function version(path) {
    return JSON.parse(readFileSync(new URL(path, import.meta.url))).version;
}

describe('Version', () => {
    it('is a semantic version with the noVNC version as build metadata', () => {
        const [own, bundled] = version('../../package.json').split('+');
        match(own, /^\d+\.\d+\.\d+$/);
        strictEqual(bundled, version('../../noVNC/package.json'));
    });
});
