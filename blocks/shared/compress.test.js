import { describe, expect, it } from 'vitest'

import { compress, decompressRaw } from './compress.js'

/**
 * OpenProject #3173: `compress.js`'s own suite, added alongside `decompressRaw` -- the module was
 * previously the one file under `shared/` without a co-located test, exercised only as a side effect
 * of `block-kroki`/`block-plantuml`'s own suites.
 */
describe('shared/compress.js', () => {
  describe('compress()', () => {
    it('deflates with a zlib header for format "deflate"', async () => {
      const bytes = await compress(new TextEncoder().encode('hello world'), 'deflate')

      // -> A zlib-wrapped deflate stream starts with a two-byte header, 0x78 being the standard
      //    "deflate, 32K window" CMF byte pako/zlib both write.
      expect(bytes[0]).toBe(0x78)
    })

    it('deflates with no header for format "deflate-raw"', async () => {
      const bytes = await compress(new TextEncoder().encode('hello world'), 'deflate-raw')

      expect(bytes[0]).not.toBe(0x78)
    })
  })

  describe('decompressRaw()', () => {
    it('round-trips arbitrary text through compress(..., "deflate-raw")', async () => {
      const original = 'The quick brown fox jumps over the lazy dog. 日本語のテキストも。'
      const compressed = await compress(new TextEncoder().encode(original), 'deflate-raw')

      const result = await decompressRaw(compressed)

      expect(result).toBe(original)
    })

    it('round-trips an empty payload', async () => {
      const compressed = await compress(new Uint8Array(), 'deflate-raw')

      const result = await decompressRaw(compressed)

      expect(result).toBe('')
    })

    it('rejects bytes that are not a valid raw-deflate stream, rather than returning garbage', async () => {
      const bogus = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      await expect(decompressRaw(bogus)).rejects.toThrow()
    })
  })
})
