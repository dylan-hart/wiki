/**
 * Deflates `bytes` through the browser's native `CompressionStream`, replacing the bundled-zlib
 * `pako` `block-kroki` (`deflate`, zlib header) and `block-plantuml` (`deflateRaw`, no header) used
 * for the same job -- packing a diagram source into a GET URL. Every browser able to run these Lit
 * blocks implements `CompressionStream`, including both `'deflate'` and `'deflate-raw'`.
 *
 * `decompressRaw` below is the other direction, used by `block-drawio`'s `mxgraph.js` to read a
 * compressed `<diagram>` payload back out -- both directions are native now, and pako is no longer a
 * dependency of this workspace at all.
 *
 * Built from a `ReadableStream` rather than `new Blob([bytes]).stream()`: the same operation, but
 * without depending on `Blob.prototype.stream`, which jsdom (this block's test environment) does
 * not implement even though it accepts the `Blob` constructor itself.
 *
 * @param {Uint8Array} bytes
 * @param {'deflate' | 'deflate-raw'} format
 * @returns {Promise<Uint8Array>}
 */
export async function compress(bytes, format) {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
  const buffer = await new Response(
    readable.pipeThrough(new CompressionStream(format))
  ).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Inflates raw-deflate `bytes` (no zlib header) through the browser's native `DecompressionStream`
 * and decodes the result as UTF-8 text, replacing `pako`'s `inflateRaw(bytes, { toText: true })` --
 * `block-drawio`'s only remaining use of it, for reading back draw.io's compressed `<diagram>`
 * payload. `DecompressionStream('deflate-raw')` is Baseline widely available (since May 2023) and
 * present in Node 18+, the same support floor `compress()` above relies on.
 *
 * Stream/async-only, unlike pako's synchronous call -- every caller in `mxgraph.js` awaits it.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function decompressRaw(bytes) {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
  return new Response(readable.pipeThrough(new DecompressionStream('deflate-raw'))).text()
}
