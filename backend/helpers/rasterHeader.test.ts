import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import {
  bmpHeader,
  gifHeader,
  jpegHeader,
  pngHeader,
  tiffHeader,
  webpHeader
} from '../test/rasterFixtures.ts'
import { readRasterHeader } from './rasterHeader.ts'

describe('readRasterHeader', () => {
  test('sizes each format from its header alone', () => {
    assert.deepEqual(readRasterHeader(pngHeader(640, 480)), {
      format: 'png',
      width: 640,
      height: 480,
      pages: 1,
      peakPixels: 640 * 480
    })
    assert.deepEqual(
      [
        jpegHeader(800, 600),
        gifHeader(320, 200),
        webpHeader(1024, 768),
        tiffHeader([[2480, 3508]]),
        bmpHeader(300, 150)
      ].map((bytes) => {
        const header = readRasterHeader(bytes)
        return [header?.format, header?.width, header?.height]
      }),
      [
        ['jpeg', 800, 600],
        ['gif', 320, 200],
        ['webp', 1024, 768],
        ['tiff', 2480, 3508],
        ['bmp', 300, 150]
      ]
    )
  })

  test('reads a progressive JPEG frame header and both lossless and extended WebP', () => {
    assert.equal(readRasterHeader(jpegHeader(4000, 3000, 0xc2))?.width, 4000)
    assert.deepEqual(
      [
        readRasterHeader(webpHeader(5000, 16000, 'VP8L')),
        readRasterHeader(webpHeader(20000, 9, 'VP8X'))
      ].map((header) => [header?.width, header?.height]),
      [
        [5000, 16000],
        [20000, 9]
      ]
    )
  })

  test('a top-down BMP reports its height as a size, not a negative', () => {
    assert.equal(readRasterHeader(bmpHeader(300, -150))?.height, 150)
  })

  test('counts every page of a TIFF and reports the largest', () => {
    const header = readRasterHeader(
      tiffHeader([
        [100, 100],
        [9000, 9000],
        [200, 200]
      ])
    )
    assert.equal(header?.pages, 3)
    assert.equal(header?.width, 100)
    assert.equal(header?.peakPixels, 9000 * 9000)
  })

  test('a GIF holds its canvas plus every frame at once', () => {
    const header = readRasterHeader(
      gifHeader(100, 100, [
        [100, 100],
        [4000, 4000],
        [4000, 4000]
      ])
    )
    assert.equal(header?.pages, 1)
    assert.equal(header?.peakPixels, 100 * 100 * 2 + 4000 * 4000 * 2)
  })

  test('is null for text, including a list of file paths, and for formats it does not size', () => {
    for (const bytes of [
      Buffer.from('/etc/passwd\n/var/lib/wiki/data/secret.png\n'),
      Buffer.from('%PDF-1.4\n%âã\n1 0 obj'),
      Buffer.from('P6\n640 480\n255\n'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.alloc(0)
    ]) {
      assert.equal(readRasterHeader(bytes), null)
    }
  })

  test('is null for a right signature over a header that does not hold together', () => {
    const cases = {
      'PNG whose first chunk is not IHDR': Buffer.concat([
        pngHeader(1, 1).subarray(0, 12),
        Buffer.from('/etc/passwd\n')
      ]),
      'PNG with a zero width': pngHeader(0, 480),
      'JPEG with no frame header before the scan': Buffer.from([
        0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0
      ]),
      'JPEG whose height waits for a DNL marker': jpegHeader(640, 0),
      'truncated JPEG': jpegHeader(640, 480).subarray(0, 24),
      BigTIFF: Buffer.from([0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      'TIFF whose IFD lies past the end': Buffer.from([
        0x49, 0x49, 42, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0
      ]),
      'TIFF whose IFD chain loops': (() => {
        const bytes = tiffHeader([[10, 10]])
        bytes.writeUInt32LE(8, bytes.length - 4)
        return bytes
      })(),
      'TIFF with no ImageWidth': (() => {
        const bytes = tiffHeader([[10, 10]])
        bytes.writeUInt16LE(999, 10)
        return bytes
      })(),
      'WebP with a chunk it does not size': Buffer.concat([
        webpHeader(10, 10).subarray(0, 12),
        Buffer.from('ALPH\u0000\u0000\u0000\u0000/etc/passwd\n', 'latin1')
      ]),
      'BMP with an unknown DIB header size': (() => {
        const bytes = bmpHeader(10, 10)
        bytes.writeUInt32LE(7, 14)
        return bytes
      })()
    }
    for (const [name, bytes] of Object.entries(cases)) {
      assert.equal(readRasterHeader(bytes), null, name)
    }
  })

  test('stops walking a TIFF one page past its own page ceiling', () => {
    const pages = Array.from({ length: 1200 }, () => [1, 1] as const)
    assert.equal(readRasterHeader(tiffHeader(pages))?.pages, 1001)
  })
})

describe('readRasterHeader against real encoders', () => {
  let sharp: any

  before(async () => {
    try {
      ;({ default: sharp } = await import('sharp'))
    } catch {
      sharp = null
    }
  })

  test('agrees with Sharp on every format Sharp writes', async (t) => {
    if (!sharp) {
      return t.skip('sharp is not installed')
    }
    const base = () =>
      sharp({ create: { width: 321, height: 123, channels: 3, background: '#c00' } })
    const encoded = {
      png: await base().png().toBuffer(),
      jpeg: await base().jpeg().toBuffer(),
      progressiveJpeg: await base().jpeg({ progressive: true }).toBuffer(),
      gif: await base().gif().toBuffer(),
      webp: await base().webp().toBuffer(),
      losslessWebp: await base().webp({ lossless: true }).toBuffer(),
      alphaWebp: await base().ensureAlpha(0.5).webp().toBuffer(),
      tiff: await base().tiff().toBuffer(),
      lzwTiff: await base().tiff({ compression: 'lzw' }).toBuffer()
    }
    for (const [name, bytes] of Object.entries(encoded)) {
      const header = readRasterHeader(bytes)
      assert.deepEqual([header?.width, header?.height], [321, 123], name)
    }
  })
})
