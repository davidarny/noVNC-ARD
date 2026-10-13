/*
 * noVNC-ARD: answers to the server's session question.
 *
 * Run: node --test ard/tests/test.session-select.js
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';

import { sessionCommand, sessionSelectAction } from '../session-select.js';

const REQUEST_CONSOLE = 0;
const CONNECT_TO_CONSOLE = 1;
const CONNECT_TO_VIRTUAL = 2;

const ALL = 0b111;
const NO_PLAIN_CONSOLE = 0b101;

describe('Session command', () => {
    it('asks for a virtual display whatever else is true', () => {
        strictEqual(sessionCommand(true, '', NO_PLAIN_CONSOLE), CONNECT_TO_VIRTUAL);
        strictEqual(sessionCommand(true, 'ada', ALL), CONNECT_TO_VIRTUAL);
    });

    it('connects to the console where the server accepts that', () => {
        strictEqual(sessionCommand(false, '', ALL), CONNECT_TO_CONSOLE);
        strictEqual(sessionCommand(false, 'ada', ALL), CONNECT_TO_CONSOLE);
    });

    it('requests the console when nobody is there and connecting is not accepted', () => {
        strictEqual(sessionCommand(false, '', NO_PLAIN_CONSOLE), REQUEST_CONSOLE);
        strictEqual(sessionCommand(false, '', 0), REQUEST_CONSOLE);
    });

    it('connects to a console someone is using, as the user chose', () => {
        strictEqual(sessionCommand(false, 'ada', NO_PLAIN_CONSOLE), CONNECT_TO_CONSOLE);
    });
});

describe('Session select action', () => {
    const action = (virtualLogin, consoleUser, pageAsks, allowedCmds = ALL) =>
        sessionSelectAction({ virtualLogin, consoleUser, allowedCmds, pageAsks });

    it('lets a set virtualLogin decide, asked or not', () => {
        for (const pageAsks of [false, true]) {
            for (const user of ['', 'ada']) {
                deepStrictEqual(action(0, user, pageAsks), { command: CONNECT_TO_CONSOLE });
                deepStrictEqual(action(2, user, pageAsks), { command: CONNECT_TO_VIRTUAL });
            }
        }
    });

    it('requests the console for virtualLogin 0 where connecting is not accepted', () => {
        deepStrictEqual(action(0, '', false, NO_PLAIN_CONSOLE), { command: REQUEST_CONSOLE });
    });

    it('connects to an unused console without asking', () => {
        deepStrictEqual(action(1, '', false), { command: CONNECT_TO_CONSOLE });
        deepStrictEqual(action(1, '', false, NO_PLAIN_CONSOLE), { command: REQUEST_CONSOLE });
    });

    it('asks when someone is using the display', () => {
        deepStrictEqual(action(1, 'ada', false), { ask: true });
        deepStrictEqual(action(1, 'ada', true), { ask: true });
    });

    it('leaves the answer to a page that is about to ask its user', () => {
        deepStrictEqual(action(1, '', true), { ask: true });
    });
});
