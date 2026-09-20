/**
 * Built from a `ReadableStream` rather than `new Blob([bytes]).stream()`: jsdom (the test
 * environment) accepts the `Blob` constructor but does not implement `Blob.prototype.stream`.
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
