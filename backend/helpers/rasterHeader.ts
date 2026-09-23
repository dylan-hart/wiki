export type RasterFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp'

export interface RasterHeader {
  format: RasterFormat
  /** The first image's, which for every format but a multi-page TIFF is the only one decoded. */
  width: number
  height: number
  /** How many images a reader will go on to decode one after another: a TIFF's IFD count, else 1. */
  pages: number
  /**
   * The most pixels a decoder holds at once. A TIFF is decoded one page at a time, so this is its
   * largest page; giflib decodes every frame of a GIF before handing back the first, so a GIF's is
   * the canvas plus all of its frames.
   */
  peakPixels: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** BITMAPINFOHEADER, Adobe's two extensions of it, OS/2 2.x's header, then V4 and V5. */
const BMP_DIB_SIZES = new Set([40, 52, 56, 64, 108, 124])

/** Past this many IFDs a TIFF is reported as having one more than it, and the walk stops. */
const MAX_TIFF_PAGES = 1000

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function sized(
  format: RasterFormat,
  width: number,
  height: number,
  extra: Partial<RasterHeader> = {}
): RasterHeader | null {
  if (!(width > 0 && height > 0)) {
    return null
  }
  return { format, width, height, pages: 1, peakPixels: width * height, ...extra }
}

function readPng(view: DataView): RasterHeader | null {
  // -> IHDR is required to be the first chunk, so the dimensions are at a fixed offset
  if (view.byteLength < 24 || view.getUint32(12) !== 0x49484452) {
    return null
  }
  return sized('png', view.getUint32(16), view.getUint32(20))
}

function readJpeg(view: DataView): RasterHeader | null {
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      return null
    }
    const marker = view.getUint8(offset + 1)
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // -> Scan data or the end of the image before any frame header: nothing to size
    if (marker === 0xd9 || marker === 0xda) {
      return null
    }
    const length = view.getUint16(offset + 2)
    // -> SOF0-SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > view.byteLength) {
        return null
      }
      return sized('jpeg', view.getUint16(offset + 7), view.getUint16(offset + 5))
    }
    if (length < 2) {
      return null
    }
    offset += 2 + length
  }
  return null
}

function skipGifSubBlocks(view: DataView, offset: number): number {
  while (offset < view.byteLength) {
    const size = view.getUint8(offset)
    offset += 1 + size
    if (size === 0) {
      return offset
    }
  }
  return -1
}

function readGif(view: DataView): RasterHeader | null {
  if (view.byteLength < 13) {
    return null
  }
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  const screenFlags = view.getUint8(10)
  let offset = 13 + (screenFlags & 0x80 ? 3 * 2 ** ((screenFlags & 0x07) + 1) : 0)
  let peakPixels = width * height
  while (offset >= 0 && offset < view.byteLength) {
    const block = view.getUint8(offset)
    if (block === 0x3b) {
      break
    }
    if (block === 0x21) {
      offset = skipGifSubBlocks(view, offset + 2)
    } else if (block === 0x2c) {
      if (offset + 11 > view.byteLength) {
        break
      }
      peakPixels += view.getUint16(offset + 5, true) * view.getUint16(offset + 7, true)
      const imageFlags = view.getUint8(offset + 9)
      offset += 10 + (imageFlags & 0x80 ? 3 * 2 ** ((imageFlags & 0x07) + 1) : 0)
      // -> The LZW minimum code size, then the image data as sub-blocks
      offset = skipGifSubBlocks(view, offset + 1)
    } else {
      break
    }
  }
  return sized('gif', width, height, { peakPixels })
}

function readWebp(view: DataView): RasterHeader | null {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const chunk = ascii(bytes, 12, 16)
  if (chunk === 'VP8 ' && view.byteLength >= 30) {
    // -> A 3-byte frame tag, then the 9d 01 2a start code, then two 14-bit dimensions
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) {
      return null
    }
    return sized('webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
  }
  if (chunk === 'VP8L' && view.byteLength >= 25) {
    if (view.getUint8(20) !== 0x2f) {
      return null
    }
    const bits = view.getUint32(21, true)
    return sized('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X' && view.byteLength >= 30) {
    const width = (view.getUint16(24, true) | (view.getUint8(26) << 16)) + 1
    const height = (view.getUint16(27, true) | (view.getUint8(29) << 16)) + 1
    return sized('webp', width, height)
  }
  return null
}

function readTiff(view: DataView): RasterHeader | null {
  const little = view.getUint8(0) === 0x49
  // -> Classic TIFF only: a BigTIFF (43) is a format leptonica does not recognize
  if (view.byteLength < 8 || view.getUint16(2, little) !== 42) {
    return null
  }
  const seen = new Set<number>()
  let offset = view.getUint32(4, little)
  let first: { width: number; height: number } | null = null
  let pages = 0
  let peakPixels = 0
  while (offset !== 0) {
    if (seen.has(offset) || offset + 2 > view.byteLength) {
      return null
    }
    seen.add(offset)
    const entries = view.getUint16(offset, little)
    const next = offset + 2 + entries * 12
    if (next + 4 > view.byteLength) {
      return null
    }
    let width = 0
    let height = 0
    for (let n = 0; n < entries; n++) {
      const entry = offset + 2 + n * 12
      const tag = view.getUint16(entry, little)
      if (tag !== 256 && tag !== 257) {
        continue
      }
      const type = view.getUint16(entry + 2, little)
      const value =
        type === 3
          ? view.getUint16(entry + 8, little)
          : type === 4
            ? view.getUint32(entry + 8, little)
            : 0
      if (tag === 256) {
        width = value
      } else {
        height = value
      }
    }
    if (!(width > 0 && height > 0)) {
      return null
    }
    first ??= { width, height }
    pages += 1
    peakPixels = Math.max(peakPixels, width * height)
    if (pages > MAX_TIFF_PAGES) {
      break
    }
    offset = view.getUint32(next, little)
  }
  if (!first) {
    return null
  }
  return sized('tiff', first.width, first.height, { pages, peakPixels })
}

function readBmp(view: DataView): RasterHeader | null {
  if (view.byteLength < 26) {
    return null
  }
  // -> An OS/2 BITMAPCOREHEADER (12 bytes) has 16-bit dimensions; every later header, 32-bit
  //    signed ones, with a negative height meaning the rows run top-down
  const dibSize = view.getUint32(14, true)
  if (dibSize === 12) {
    return sized('bmp', view.getUint16(18, true), view.getUint16(20, true))
  }
  if (!BMP_DIB_SIZES.has(dibSize)) {
    return null
  }
  return sized('bmp', Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)))
}

/**
 * Identifies a raster image from its own bytes and reads its dimensions from the header alone,
 * decoding nothing. `null` for anything it cannot place or size — including a truncated or
 * malformed header — so a caller can treat `null` as "not an image", never as "an image of unknown
 * size".
 */
export function readRasterHeader(bytes: Uint8Array): RasterHeader | null {
  if (bytes.length < 12) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (PNG_SIGNATURE.every((byte, n) => bytes[n] === byte)) {
    return readPng(view)
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return readJpeg(view)
  }
  const head = ascii(bytes, 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') {
    return readGif(view)
  }
  if (head.startsWith('RIFF') && ascii(bytes, 8, 12) === 'WEBP') {
    return readWebp(view)
  }
  if (head.startsWith('II*\u0000') || head.startsWith('MM\u0000*')) {
    return readTiff(view)
  }
  if (head.startsWith('BM')) {
    return readBmp(view)
  }
  return null
}
