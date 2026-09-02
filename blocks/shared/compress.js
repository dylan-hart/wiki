/**
 * Deflates `bytes` through the browser's native `CompressionStream`, replacing the bundled-zlib
 * `pako` `block-kroki` (`deflate`, zlib header) and `block-plantuml` (`deflateRaw`, no header) used
 * for the same job -- packing a diagram source into a GET URL. Every browser able to run these Lit
 * blocks implements `CompressionStream`, including both `'deflate'` and `'deflate-raw'`.
 *
 * The dependency itself stays: `block-drawio`'s `mxgraph.js` still inflates a compressed diagram
 * with `pako`'s `inflateRaw`, which is the other direction and has no `DecompressionStream`
 * conversion here.
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
