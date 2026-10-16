/*
 * noVNC-ARD: answering the server's session question (Session Select).
 *
 * Kept free of browser dependencies so it can be tested on its own.
 */

import {
    sessionCmdRequestConsole,
    sessionCmdConnectToConsole,
    sessionCmdConnectToVirtualDisplay,
} from './ard-constants.js';

/*
 * The command that asks for the Mac's own display (virtual false) or a
 * virtual display.
 *   consoleUser:  who is using the Mac's display, '' if nobody
 *   allowedCmds:  the commands the server accepts, one bit each
 * With nobody at the console, a server that does not accept a plain
 * connection to it expects a request instead.
 */
export function sessionCommand(virtual, consoleUser, allowedCmds) {
    if (virtual) return sessionCmdConnectToVirtualDisplay;
    if (!consoleUser && !(allowedCmds & (1 << sessionCmdConnectToConsole))) {
        return sessionCmdRequestConsole;
    }
    return sessionCmdConnectToConsole;
}

/*
 * What to do when the server asks which session to open.
 *   virtualLogin:  0 always the Mac's display, 2 always a virtual display, 1 ask
 *   pageAsks:      the page asks its user about every connection and has
 *                  not done so yet on this one
 * Returns { command } to send, or { ask: true } to leave it to the page.
 * A set virtualLogin decides. Otherwise the page is asked when someone is
 * using the display, and also when it has a question of its own to put:
 * its user must not find the answer already given.
 */
export function sessionSelectAction({ virtualLogin, consoleUser, allowedCmds, pageAsks }) {
    if (virtualLogin === 0 || virtualLogin === 2) {
        return { command: sessionCommand(virtualLogin === 2, consoleUser, allowedCmds) };
    }
    if (!consoleUser && !pageAsks) {
        return { command: sessionCommand(false, consoleUser, allowedCmds) };
    }
    return { ask: true };
}
