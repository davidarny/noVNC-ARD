<p><img src="ard/images/noVNC-ARD-logo.png" alt="noVNC-ARD" width="490"></p>

ARD protocol extensions for [noVNC](https://github.com/novnc/noVNC).

A browser-based client for macOS Screen Sharing (protocol version `003.889`). All ARD-specific code lives in a standalone monkey-patch layer on top of an untouched upstream noVNC git submodule. Standard VNC connections pass through unmodified.

## Features

**Authentication**
- Type 30 (Diffie-Hellman) and Type 33 (RSATunnel) credential exchange
- Keystroke encryption (AES-128-ECB) for individual key events
- Full tunnel encryption (AES-128-CBC + SHA-1 integrity)

**Session Management**
- Session Select dialog (share console or connect to virtual display)
- Auto-reconnect with exponential backoff
- Control modes: observe, shared, exclusive

**UI Controls**
- Quality slider with 5 presets (adaptive, millions, thousands, gray, halftone)
- Clipboard sync, send, and receive
- Display selector for Macs with several displays (one display, or all combined)
- Curtain screen lock with custom message
- Remote user avatar display
- Mac modifier key labels (Cmd, Opt)
- Connection info panel

**Pixel Decoders**
- Halftone (encoding 1000) — 1-bit black/white, zlib-compressed
- Gray16 (encoding 1001) — 4-bit 16 grays, zlib-compressed
- Thousands (encoding 1002) — 16-bit RGB555, zlib-compressed
- MVS (encoding 1011) — Apple's adaptive-quality codec: 8×8 DCT tiles with a tile cache and partial updates

**Keyboard**
- Double-backtick shortcut for full screen refresh

## Quick Start

```bash
# Clone with submodule
git clone --recurse-submodules https://github.com/peetinc/noVNC-ARD.git

# Proxy a macOS Screen Sharing server through websockify
websockify --web . 6088 <host>:5900

# Open in browser
open http://localhost:6088/ard.html
```

## URL Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `theme` | string | `novnc` | UI theme: `novnc`, `novnc-ard`, `noard` |
| `ardQuality` | string | `adaptive` | Initial quality preset: `halftone`, `gray`, `thousands`, `millions`, `adaptive`, `highperf` (experimental, see [High Performance Mode](#high-performance-mode-experimental)) |
| `ardSessionType` | string | ask | Skips the session dialog: `share` (the Mac's own displays), `virtual` (virtual login, standard quality) or `highperf` (virtual display in High Performance) |
| `ardMediaPath` | string | `media` | Path of the relay's media WebSocket, used by `highperf` |
| `ardHpVirtualDisplay` | boolean | `true` | In `highperf`, ask the Mac for a virtual display at 3840×2160. `false` shows its real displays |
| `ardResolution` | string | — | The size of the virtual display to ask the Mac for, in a virtual display login of either quality. In points: `1600x900` (drawn at 2 pixels to the point), `2560x1440@1` (with the scale, 1 or 2), `window` (the size of the browser window, at 1) or `window@2`. The picture is kept within the number of pixels of 3840×2160 (8.3 million), in whatever shape; a window wider than 16:9 can therefore be wider than 3840 pixels, which no Mac has yet been asked for. See "A display the size of the window". `ardHpResolution` is the same parameter under its first name |
| `ardHpAudio` | boolean | `true` | In `highperf`, play the Mac's sound |
| `ardHpFeedback` | string | all | Which RTCP the viewer sends in `highperf`: a comma list of `rr`, `ack`, `rctl`. For protocol testing |
| `ardEncryption` | integer | `2` | Encryption mode: `1` = keystroke-only, `2` = full tunnel |
| `ardControlMode` | integer | `1` | Control mode: `0` = observe, `1` = shared, `2` = exclusive |
| `virtualLogin` | integer | `1` | Session select: `0` = always share, `1` = show picker, `2` = always virtual |
| `ardAutoSelectDisplay` | boolean | `true` | With several displays, start on the main display. `false` starts on all displays combined, as does hiding the selector |
| `showArdUserAvatar` | boolean | `true` | Show remote user avatar in sidebar |
| `showArdClipboard` | boolean | `true` | Show clipboard buttons |
| `showArdScreenLock` | boolean | `true` | Show curtain lock button |
| `showArdQuality` | boolean | `true` | Show quality selector |
| `showArdDisplaySelect` | boolean | `true` | Show display selector (appears when the remote Mac has more than one display) |

## Public API

### Methods

| Method | Description |
|--------|-------------|
| `forceClipboardPaste(text)` | Send local clipboard text to remote |
| `requestRemoteClipboard()` | Request clipboard contents from remote server |
| `enableClipboardSync(enabled)` | Enable or disable automatic clipboard sync |
| `ardCurtainLock(message?)` | Lock remote screen with optional message |
| `ardCurtainUnlock()` | Unlock remote screen |
| `requestFullUpdate()` | Request full framebuffer update |
| `selectSessionType(command)` | Resume session select: `1` = console, `2` = virtual display |
| `ardContinueSession()` | Resume after `ardsessionchoice` |

### Properties

| Property | Type | Access | Description |
|----------|------|--------|-------------|
| `ardControlMode` | integer | read/write | `0` = observe, `1` = shared, `2` = exclusive |
| `ardQualityPreset` | string | read/write | `halftone`, `gray`, `thousands`, `millions`, `adaptive` |
| `ardCurtainActive` | boolean | read-only | Whether remote screen is curtain-locked |
| `ardAudioMuted` | boolean | read/write | Mute the Mac's sound in High Performance mode |
| `ardHighPerformanceActive` | boolean | read-only | Whether High Performance media is on screen |
| `ardSelectedDisplay` | integer or null | read/write | Display being viewed: a display `id` from `arddisplayinfo`, or `null` for all displays combined |

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `ardsessionselect` | `{ username, allowedCommands, hasConsoleUser }` | Server requests session type selection |
| `ardsessionchoice` | `{ serverFlags, capabilityBitmap, username }` | Signed in and waiting, before anything is asked of the server. Only when `_ardAskSessionChoice` is set; set the quality preset, then call `ardContinueSession()` |
| `arduserinfo` | `{ username, hasAvatar }` | Remote user info received |
| `arddisplayinfo` | `{ width, height, displays }` | Display list received or changed. Each display has `id`, `main`, `w`, `h` |
| `ardcurtainchange` | `{ active }` | Curtain lock state changed |
| `ardencryptionstate` | `{ state }` | Session encryption activated |
| `ardhpstate` | `{ state, reason, failure, video, stats }` | High Performance session changed state: `offering`, `waiting`, `streaming`, `failed`, `closed` |

## Versioning

Versions look like `1.0.0+1.6.0`: the noVNC-ARD version, then the version of the bundled noVNC submodule as [build metadata](https://semver.org/#spec-item-10). The first part follows semantic versioning for the ARD layer. The second part changes only when the submodule is updated, and does not affect version ordering.

## Quality Presets

| Preset | Encoding List | Pixel Depth |
|--------|--------------|-------------|
| `halftone` | ArdHalftone, ZRLE, Zlib, Raw | 1-bit (black/white) |
| `gray` | ArdGray16, ZRLE, Zlib, Raw | 4-bit (16 grays) |
| `thousands` | ArdThousands, ZRLE, Zlib, Raw | 16-bit (RGB555) |
| `millions` | ZRLE, Zlib, Raw | 24-bit (full color) |
| `adaptive` (default) | ArdMVS, ArdThousands, ZRLE, Zlib, Raw | 24-bit, lossy (DCT) |

All presets include standard fallback encodings (CopyRect, Hextile, RRE) and ARD pseudo-encodings (CursorPos, DisplayInfo, UserInfo, SessionEncryption, CursorAlpha, DisplayInfo2, DeviceInfo, KeyboardInput).

`highperf` sends the `adaptive` list with ProMode (1010) first and MediaStream (1110) last.

## High Performance Mode (experimental)

macOS 14 and later can send the screen as HEVC video over UDP instead of framebuffer updates: Screen Sharing's "High Performance" connection type.

Once signed in, a dialog asks what kind of session to open: **Share Display**, or **Virtual Display** in **High Performance** or **Standard** quality. It comes after sign-in, as in Apple's Screen Sharing, because only then is it known what the connection can do; the same dialog answers the Mac's own question when someone else is using its display. Standard is the ordinary virtual login, as before; High Performance has the Mac create one virtual display at 3840×2160. The last choice is remembered, and reconnects do not ask again. High Performance is greyed out, with the reason, when the browser cannot decode it, the relay has no media channel or another viewer is using it (checked while the dialog is open, without disturbing that viewer). `?ardSessionType=highperf` (or `?ardQuality=highperf`) chooses it without the dialog. During a High Performance session the toolbar has a button to mute the Mac's sound, and the info panel shows the picture size, bit rate and whether sound is playing.

**Status: works against macOS 27 servers** (first live sessions 2026-10-12): the Mac creates a virtual display for the viewer and sends it at 3840×2160; sound plays. Experimental all the same: one relay, one session, no recovery from packet loss.

The server sends the media as UDP to the address of its TCP peer, which a browser cannot receive, so websockify is not enough. Use the relay in `relay/`, which bridges TCP like websockify and also carries the UDP over a second WebSocket:

```bash
# Run on a machine other than the Mac being viewed; needs UDP 5900 and 5901 free
node relay/relay.mjs --listen 6088 --target <host>

open "http://localhost:6088/ard.html?ardQuality=highperf"
```

Requirements:

- A browser that decodes HEVC 4:4:4 through WebCodecs. Chrome, Edge and Safari on Apple silicon do; Firefox does not. Otherwise the page connects as `adaptive`.
- The relay must be reachable from the Mac on UDP 5900 and 5901, and those ports must be free on the relay's machine.
- A machine fast enough: nothing can be left out of the stream, so a viewer that stays more than half a second behind for two seconds ends the session and carries on in Standard. Decryption runs on the page's main thread; measured in Chrome on Apple silicon it takes about 1 ms a packet at 7,500 packets a second (50 Mbit/s) without holding up the page.
- One High Performance session per relay: the newest takes the media. The session dialog says when another viewer is using it.

Encryption: the picture and the sound are always encrypted (SRTP), with keys the viewer chooses and sends to the Mac on the RFB connection. With `ardEncryption=2` that connection is encrypted, and the keys are not sent before it is. With `ardEncryption=1` only sign-in and keystrokes are, so the keys cross the network in the clear and anyone who records the whole session can decrypt its media: use mode 1 only on a network you trust, or inside a tunnel.

Who may use the relay: it asks nobody who they are, so run it where only the people meant to reach the Mac can reach it (by default it listens on `127.0.0.1`). A web page may connect only if the relay served it, opened by IP address, as `localhost` or under the relay machine's own name, so that other sites open in the same browser cannot reach the Mac through it. To let a page served from somewhere else connect, name its origin: `--allow-origin https://viewer.example.com` (may be repeated). Clients that are not web pages are not restricted. Directories named `private` or `node_modules`, and dotfiles, are never served.

The mode is chosen when the connection is made. If it cannot start, the page logs the reason and reconnects as `adaptive`. The same happens when the connection is lost before the picture arrives or within a minute of it, so a Mac that hangs up on the attempt is not asked twice.

**Which Macs are asked.** Only those whose sign-in reply carries the capability bits seen on every Mac that has sent the mode as HEVC; for any other Mac the dialog greys High Performance out ("this Mac does not offer it"). In practice that leaves out Intel Macs, as Apple's own viewers do. An Intel Mac can be made to enter the mode, and then sends H.264, but in tests it did so undependably and kept the display it had made for the session afterwards; this viewer does not ask it and does not read H.264. The reading of those bits rests on few Macs: if High Performance is greyed out for an Apple silicon Mac that Apple's Screen Sharing offers it for, that is a bug here. Choosing High Performance in the dialog tries again. The picture is drawn at the display's pixel resolution on a canvas laid over noVNC's own, which keeps handling input and the cursor.

The protocol code is in `ard/hp/`: negotiation (`negotiation.js`, `offer-template.js`, `virtual-display.js`, `plist.js`, `protobuf.js`, `zlib.js`), SRTP (`srtp.js`), picture reassembly (`rtp-video.js`), RTCP feedback (`feedback.js`), decoding and painting (`video-sink.js`, `hevc.js`), sound (`audio.js`, `rtp-audio.js`, `audio-decoder.js`, `audio-sink.js`, `pcm-worklet.js`, `pcm-ring.js`) and the session that ties them together (`session.js`).

### A display the size of the window

`ardResolution=window` asks the Mac to make the virtual display exactly as large as the browser window, so the desktop fills it with nothing scaled and nothing cut off. It works in a virtual display login of Standard quality as well as in High Performance: the request that Apple's viewer sends for High Performance is honoured by an Apple silicon Mac in an ordinary session too.

```
ard.html?ardSessionType=virtual&ardResolution=window
```

The display is sized when the session is set up. **Resizing the window afterwards does not change it.**

What to know:

- `window` asks for one pixel to the point. `window@2` asks for two (HiDPI).
- **A Mac will not show a display below a certain size as asked**: it marks the mode unsupported and shows 800×600 at two pixels to the point instead (a picture of 1600×1200). Seen for 1478×480 at two. The viewer therefore asks for at least 800 points wide, and at least 540 high at two pixels to the point or 480 at one, enlarging a smaller window's size in its own shape; the desktop is then shown a little reduced. The Mac's true limits are somewhere below those.
- **A display can be given another size on a later connection, never one beyond the size it was made with.** The Mac keeps the display it made and changes its size when the next session asks for another: applied exactly 7 times in 7, with as little as 2 seconds between sessions, whenever the new size was no wider and no taller in pixels than the largest size stated when the display was made. Beyond that, never as asked, 7 times in 7: three times the Mac gave fewer pixels than asked (the size in points, at one pixel to the point, or half the points at two), four times it kept the old size and sent no picture at all.
- The viewer therefore asks for every display with room for 3840×2160 pixels (more in one direction when the window's shape needs it), whatever size it wants first. **This remedy has not yet been tried against a Mac.** A display made small by an earlier version of this viewer stays small until the Mac drops it.
- The Mac drops the display when a High Performance session ends, and otherwise when its Screen Sharing service stops, which it does 15 seconds after the last viewer has left.
- Sessions of the same user share one virtual display.
- After a session on a virtual display is lost, the viewer waits 6 seconds before connecting again. A Mac needs over a second to take such a session down, and longer after a logout; a request for a virtual display that arrived 1.2 seconds after a logout was followed by the Mac's window server crashing (macOS 27.0.1, once).
- A Mac that sends no picture to any viewer needs Screen Sharing restarted on it (`sudo launchctl kickstart -k system/com.apple.screensharing`).
- Tried against one Apple silicon Mac (macOS 27), from one browser, over two days.

### Sound and the bundled decoder

The sound is AAC-ELD, which no browser decodes. `ard/hp/vendor/libav/` holds FFmpeg's AAC decoder compiled to WebAssembly as a [libav.js](https://github.com/Yahweasel/libav.js) variant with nothing else in it (about 1 MB). It is loaded only when a High Performance session starts with sound on.

That binary is FFmpeg under the **LGPL 2.1 or later**; the libav.js wrapper around it is 0-clause BSD. The exact sources it was built from are in `ard/hp/vendor/libav/sources/`, and `tools/build-libav.sh` rebuilds it (needs Docker). This applies to the files in that directory only; the rest of noVNC-ARD keeps its own licence.

## Project Structure

```
noVNC-ARD/
  noVNC/                        git submodule (upstream, untouched)
  ard/
    ard-constants.js            encoding IDs, message types, status codes
    ard-patch.js                monkey-patches RFB prototype for ARD support
    display-info.js             display list, display selection (no browser dependencies)
    crypto/
      aes128.js                 AES-128 (ECB + CBC modes)
      sha1.js                   SHA-1 hash
      pkcs1.js                  PKCS#1 DER public key parser
    decoders/
      zlib-halftone.js          1-bit halftone decoder (encoding 1000)
      zlib-16gray.js            4-bit gray decoder (encoding 1001)
      zlib-thousands.js         16-bit RGB555 decoder (encoding 1002)
      mvs.js                    MVS decoder (encoding 1011)
      mvs-bitstream.js          MVS bit reader
      mvs-rice.js               MVS Rice codes (full updates)
      mvs-huffman.js            MVS Huffman AC codes (partial updates)
      mvs-idct.js               MVS inverse DCT (libjpeg islow)
      mvs-tables.js             MVS zigzag, quantization and color tables
    images/
      binoculars.svg            Observe mode icon (Lucide, ISC)
      cmd.svg                   Mac Command key icon (Lucide, ISC)
      disconnect.svg            Disconnect icon (Lucide, ISC)
      opt.svg                   Mac Option key icon (Lucide, ISC)
      quality.svg               Quality selector icon (Lucide, ISC)
      quality-high.svg          High quality indicator (Lucide, ISC)
      quality-low.svg           Low quality indicator
      user.svg                  Default user avatar (Lucide, ISC)
    tests/
      test.crypto.js            AES, SHA-1, PKCS#1 tests (FIPS/NIST vectors)
      test.display-info.js      display list and display selection tests
      test.mvs.js               MVS decoder tests (hand-built bitstreams)
      test.version.js           version format test
      test.wire.js              ARD wire format and message builder tests
  ard.html                      entry point (loads noVNC + ARD patch)
  ard.css                       ARD-specific styles
```

## Testing

Tests use Node.js built-in test runner (`node:test`):

```bash
# Run all tests
node --test ard/tests/test.*.js

# Run individually
node --test ard/tests/test.crypto.js         # crypto primitives
node --test ard/tests/test.wire.js           # wire format + message builders
node --test ard/tests/test.mvs.js            # MVS decoder
node --test ard/tests/test.display-info.js   # display list + selection
node --test ard/tests/test.hp-*.js           # High Performance mode
node --test relay/test.relay.js              # relay
```

`test.hp-replay.js` runs a captured High Performance session through the receive path. Captures hold screen contents and session keys, so none is included; the test is skipped unless `HP_REPLAY_FIXTURE` names a fixture file.

Crypto tests validate against FIPS 197 and NIST test vectors. Wire tests cover ARD message byte patterns, session select event dispatch, and state machine transitions.

## Architecture

The patch is organized in two layers:

**Layer 1 — Protocol Scaffolding**
Detection (`003.889` version string), Apple-extended ClientInit (`0xC1`), Extended ServerInit parsing, ARD message dispatch, encoding negotiation, and 0x0 framebuffer guard.

**Layer 2 — Features**
- *Auth & Encryption:* Type 30 DH, Type 33 RSATunnel, EncryptedEvent (keystroke AES-128-ECB), full session encryption (AES-128-CBC + SHA-1)
- *Session:* Session Select sub-protocol, clipboard sync/send/receive, curtain screen lock, control mode switching, remote user avatar, quality preset switching
- *Pixel Decoders:* Zlib-compressed ARD formats and the MVS DCT codec, converted to RGBA for canvas

**Crypto Primitives**
Pure JavaScript — AES-128, SHA-1, PKCS#1 DER parsing. No external dependencies.

## License

This project is licensed under the [Mozilla Public License 2.0](LICENSE).

**Upstream noVNC** is licensed under [MPL 2.0](https://github.com/novnc/noVNC/blob/master/LICENSE.txt) and lives in the `noVNC/` submodule with its own license file.

**Lucide icons** are licensed under the [ISC License](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (Copyright Lucide Contributors): `binoculars.svg`, `cmd.svg`, `disconnect.svg`, `opt.svg`, `quality.svg`, `quality-high.svg`, `user.svg`.

Remaining SVG icons in `ard/images/` (`quality-low.svg`) are original work covered by this project's MPL 2.0 license.
