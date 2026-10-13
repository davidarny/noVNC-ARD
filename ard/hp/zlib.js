/*
 * noVNC-ARD: zlib (RFC 1950) streams on the platform's compression streams
 *
 * The 'deflate' format of CompressionStream / DecompressionStream is the zlib
 * wrapper (2-byte header, deflate data, Adler-32), not raw deflate.
 */

// Push `bytes` through a transform stream and collect everything it produces.
async function run(stream, bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('zlib: input must be a Uint8Array');

    // A failed stream rejects the writes as well as the reads. The read loop
    // below reports the error; silence the write side so it is not also
    // raised as an unhandled rejection.
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});

    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
    }

    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
        out.set(chunk, pos);
        pos += chunk.length;
    }
    return out;
}

/**
 * Compress to a zlib stream.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function deflate(bytes) {
    return run(new CompressionStream('deflate'), bytes);
}

/**
 * Decompress a zlib stream. Rejects on corrupt or truncated input.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function inflate(bytes) {
    return run(new DecompressionStream('deflate'), bytes);
}
