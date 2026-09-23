/**
 * Headers only, never decodable images: enough for `helpers/rasterHeader.ts` to identify and size,
 * which is all a test of a size or format gate needs. Each is as short as its format allows.
 */

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32le(value: number): number[] {
  return [...u16le(value & 0xffff), ...u16le(value >>> 16)]
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff]
}

function u32be(value: number): number[] {
  return [...u16be(value >>> 16), ...u16be(value & 0xffff)]
}

function latin1(text: string): number[] {
  return [...Buffer.from(text, 'latin1')]
}

export function pngHeader(width: number, height: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...latin1('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    2,
    0,
    0,
    0,
    ...u32be(0)
  ])
}

/** An APP0 segment ahead of the frame header, as every real JFIF file has. */
export function jpegHeader(width: number, height: number, sof = 0xc0): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...latin1('JFIF\u0000'),
    1,
    1,
    0,
    ...u16be(1),
    ...u16be(1),
    0,
    0,
    0xff,
    sof,
    ...u16be(11),
    8,
    ...u16be(height),
    ...u16be(width),
    1,
    1,
    0x11,
    0
  ])
}

/** `frames` are image descriptors after the logical screen, each with one empty data block. */
export function gifHeader(
  width: number,
  height: number,
  frames: Array<readonly [number, number]> = [[width, height]]
): Buffer {
  const bytes = [...latin1('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]
  for (const [frameWidth, frameHeight] of frames) {
    bytes.push(
      0x21,
      0xf9,
      4,
      0,
      0,
      0,
      0,
      0,
      0x2c,
      ...u16le(0),
      ...u16le(0),
      ...u16le(frameWidth),
      ...u16le(frameHeight),
      0,
      2,
      1,
      0,
      0
    )
  }
  bytes.push(0x3b)
  return Buffer.from(bytes)
}

export function webpHeader(
  width: number,
  height: number,
  chunk: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8 '
): Buffer {
  let body: number[]
  if (chunk === 'VP8 ') {
    body = [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]
  } else if (chunk === 'VP8L') {
    body = [0x2f, ...u32le(((width - 1) | ((height - 1) << 14)) >>> 0)]
  } else {
    body = [0, 0, 0, 0, ...u32le(width - 1).slice(0, 3), ...u32le(height - 1).slice(0, 3)]
  }
  return Buffer.from([
    ...latin1('RIFF'),
    ...u32le(4 + 8 + body.length),
    ...latin1('WEBP'),
    ...latin1(chunk),
    ...u32le(body.length),
    ...body
  ])
}

/** Little-endian, one IFD per page, each holding just its ImageWidth (LONG) and ImageLength
 *  (SHORT) — both entry types a writer may choose. */
export function tiffHeader(pages: Array<readonly [number, number]>): Buffer {
  const bytes = [...latin1('II'), ...u16le(42), ...u32le(8)]
  pages.forEach(([width, height], n) => {
    const next = n === pages.length - 1 ? 0 : bytes.length + 2 + 2 * 12 + 4
    bytes.push(
      ...u16le(2),
      ...u16le(256),
      ...u16le(4),
      ...u32le(1),
      ...u32le(width),
      ...u16le(257),
      ...u16le(3),
      ...u32le(1),
      ...u16le(height),
      0,
      0,
      ...u32le(next)
    )
  })
  return Buffer.from(bytes)
}

/** A BITMAPINFOHEADER; a negative `height` is a top-down bitmap. */
export function bmpHeader(width: number, height: number): Buffer {
  const view = Buffer.alloc(54)
  view.write('BM', 0, 'latin1')
  view.writeUInt32LE(40, 14)
  view.writeInt32LE(width, 18)
  view.writeInt32LE(height, 22)
  return view
}
