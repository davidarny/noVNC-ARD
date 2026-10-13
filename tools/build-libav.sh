#!/usr/bin/env bash
# Builds the ard-aac variant of libav.js: FFmpeg's AAC decoder and nothing
# else, compiled to WebAssembly. High Performance mode sends its sound as
# AAC-ELD, which no browser decodes; this is the decoder the page ships.
#
# The Emscripten toolchain runs in a container rather than being installed on
# the host. Needs Docker and network access (npm, the emsdk image).
#
# Usage: tools/build-libav.sh [workdir]
set -euo pipefail

VERSION=6.10.9
FFMPEG_VERSION=9.0
VARIANT=ard-aac
IMAGE=emscripten/emsdk:latest

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/libav-build-ard}"
OUT="$ROOT/ard/hp/vendor/libav"

# Packets are fed raw, so no demuxer, parser, filter or resampler is needed.
FRAGMENTS='["avcodec","decoder-aac"]'

# Audio decoding costs next to nothing; build for size.
OPTFLAGS="${OPTFLAGS:--Oz}"

# ---------------------------------------------------------------- fetch
if [ ! -d "$WORK/src" ]; then
    mkdir -p "$WORK/pkg"
    cd "$WORK/pkg"
    npm pack "libav.js@$VERSION" >/dev/null
    tar xzf "libav.js-$VERSION.tgz"
    mkdir -p "$WORK/src"
    tar xJf package/sources/libav.js.tar.xz -C "$WORK/src"
    # The npm package ships the ffmpeg tarball too.
    mkdir -p "$WORK/src/build"
    cp "package/sources/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/src/build/"
fi

# ---------------------------------------------------------------- configure
cd "$WORK/src/configs"
node ./mkconfig.js "$VARIANT" "$FRAGMENTS"
echo "--- ffmpeg configure flags for $VARIANT"
cat "configs/$VARIANT/ffmpeg-config.txt"

# ---------------------------------------------------------------- build
cd "$WORK/src"
docker run --rm \
    -v "$WORK/src:/src" \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    "$IMAGE" \
    bash -lc "cd /src && npm install --no-audit --no-fund && \
        make -j\$(nproc) OPTFLAGS=$OPTFLAGS \
            dist/libav-$VERSION.0-$VARIANT.mjs \
            dist/libav-$VERSION.0-$VARIANT.wasm.mjs \
            dist/libav.types.d.ts"

# ---------------------------------------------------------------- install
mkdir -p "$OUT/sources"
cp "$WORK/src/dist/libav-$VERSION.0-$VARIANT".* "$OUT/"
# LGPL: the sources of what is shipped go with it.
cp "$WORK/pkg/package/sources/ffmpeg-$FFMPEG_VERSION.tar.xz" \
   "$WORK/pkg/package/sources/libav.js.tar.xz" "$OUT/sources/"

ls -l "$OUT" "$OUT/sources"
