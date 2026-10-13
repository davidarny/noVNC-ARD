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
| `ardMediaPath` | string | `media` | Path of the relay's media WebSocket, used by `highperf` |
| `ardHpVirtualDisplay` | boolean | `true` | In `highperf`, ask the Mac for a virtual display at 3840×2160. `false` shows its real displays |
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

### Properties

| Property | Type | Access | Description |
|----------|------|--------|-------------|
| `ardControlMode` | integer | read/write | `0` = observe, `1` = shared, `2` = exclusive |
| `ardQualityPreset` | string | read/write | `halftone`, `gray`, `thousands`, `millions`, `adaptive` |
| `ardCurtainActive` | boolean | read-only | Whether remote screen is curtain-locked |
| `ardSelectedDisplay` | integer or null | read/write | Display being viewed: a display `id` from `arddisplayinfo`, or `null` for all displays combined |

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `ardsessionselect` | `{ username, allowedCommands, hasConsoleUser }` | Server requests session type selection |
| `arduserinfo` | `{ username, hasAvatar }` | Remote user info received |
| `arddisplayinfo` | `{ width, height, displays }` | Display list received or changed. Each display has `id`, `main`, `w`, `h` |
| `ardcurtainchange` | `{ active }` | Curtain lock state changed |
| `ardencryptionstate` | `{ state }` | Session encryption activated |
| `ardhpstate` | `{ state, reason, failure, stats }` | High Performance session changed state: `offering`, `waiting`, `streaming`, `failed`, `closed` |

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

macOS 14 and later can send the screen as HEVC video over UDP instead of framebuffer updates: Screen Sharing's "High Performance" connection type. `?ardQuality=highperf` asks for it.

**Status: not yet tested against a live server.** The receive path is verified against captured sessions; whether a server accepts this viewer's offer is unknown. Video only; audio is negotiated and discarded.

The server sends the media as UDP to the address of its TCP peer, which a browser cannot receive, so websockify is not enough. Use the relay in `relay/`, which bridges TCP like websockify and also carries the UDP over a second WebSocket:

```bash
# Run on a machine other than the Mac being viewed; needs UDP 5900 and 5901 free
node relay/relay.mjs --listen 6088 --target <host>

open "http://localhost:6088/ard.html?ardQuality=highperf"
```

Requirements:

- A browser that decodes HEVC 4:4:4 through WebCodecs. Chrome, Edge and Safari on Apple silicon do; Firefox does not. Otherwise the page connects as `adaptive`.
- The relay must be reachable from the Mac on UDP 5900 and 5901, and those ports must be free on the relay's machine.
- One High Performance session per relay.

The mode is chosen when the connection is made. If it cannot start, the page logs the reason and reconnects as `adaptive`. The picture is drawn at the display's pixel resolution on a canvas laid over noVNC's own, which keeps handling input and the cursor.

The protocol code is in `ard/hp/`: negotiation (`negotiation.js`, `offer-template.js`, `plist.js`, `protobuf.js`, `zlib.js`), SRTP (`srtp.js`), picture reassembly (`rtp-video.js`), RTCP feedback (`feedback.js`), decoding and painting (`video-sink.js`, `hevc.js`) and the session that ties them together (`session.js`).

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
