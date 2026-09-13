/*
  Guards the committed `public/favicon.ico` — the icon a browser fetches from the bare
  `/favicon.ico` root path on its own, whatever `index.html` declares.

  This reads the bytes rather than re-running `generate-favicon.mjs`: the generator needs
  Playwright's Chromium, and the whole point of committing the output is that nothing downstream
  of it does. The committed file is the Cardinal.js brand kit's own hand-supplied icon (see
  `generate-favicon.mjs`'s header) rather than one rendered from `logo-cardinal.svg` here, so what
  is asserted is that it carries the official mark's three known fills, not a value read out of the
  SVG — the two are deliberately decoupled for exactly the reason that header explains.
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICO = path.join(ROOT, 'public/favicon.ico')

const bytes = fs.readFileSync(ICO)

/**
 * Reads the ICONDIR and its ICONDIRENTRYs.
 *
 * @param {Buffer} buf
 * @returns {Array<{ width: number, height: number, planes: number, bitCount: number, length: number, offset: number }>}
 */
function readDirectory(buf) {
  const count = buf.readUInt16LE(4)
  return Array.from({ length: count }, (_unused, index) => {
    const at = 6 + index * 16
    return {
      // 0 means 256 in an ICONDIRENTRY; nothing this file carries is that large.
      width: buf.readUInt8(at) || 256,
      height: buf.readUInt8(at + 1) || 256,
      planes: buf.readUInt16LE(at + 4),
      bitCount: buf.readUInt16LE(at + 6),
      length: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12)
    }
  })
}

/**
 * Decodes one 32bpp DIB entry back to top-down RGBA.
 *
 * @param {Buffer} buf The whole file.
 * @param {{ width: number, height: number, offset: number }} entry
 * @returns {{ at: (x: number, y: number) => { r: number, g: number, b: number, a: number } }}
 */
function readPixels(buf, entry) {
  const headerSize = buf.readUInt32LE(entry.offset)
  const pixels = entry.offset + headerSize
  const stride = entry.width * 4
  return {
    at(x, y) {
      // Stored bottom-up.
      const from = pixels + (entry.height - 1 - y) * stride + x * 4
      return { b: buf[from], g: buf[from + 1], r: buf[from + 2], a: buf[from + 3] }
    }
  }
}

/** @param {{ r: number, g: number, b: number }} px @param {{ r: number, g: number, b: number }} target */
function isNear(px, target) {
  // Generous enough for the compositing at a boundary between the two fills, far tighter than the
  // distance between either fill and anything the upstream icon was drawn in.
  return (
    Math.abs(px.r - target.r) <= 12 &&
    Math.abs(px.g - target.g) <= 12 &&
    Math.abs(px.b - target.b) <= 12
  )
}

/** @param {string} hex @returns {{ r: number, g: number, b: number }} */
function parseHex(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

// The official mark's three flat fills — see `public/_assets/logo-cardinal.svg`'s own header
// comment. Hardcoded rather than read off the SVG: this icon is a hand-supplied render, not one
// generated from that file (see `generate-favicon.mjs`), so the two are checked against the same
// known constants instead of against each other.
const CRESCENT = parseHex('#f95b53')
const BODY = parseHex('#d1362f')
const INK = parseHex('#000000')

describe('public/favicon.ico', () => {
  it('is an icon resource carrying the sizes a browser and a desktop shortcut ask for', () => {
    expect(bytes.readUInt16LE(0)).toBe(0) // reserved
    expect(bytes.readUInt16LE(2)).toBe(1) // type: icon, not cursor

    const entries = readDirectory(bytes)
    expect(entries.map((e) => e.width).sort((a, b) => a - b)).toEqual([16, 32, 64])
    for (const entry of entries) {
      expect(entry.width).toBe(entry.height)
      expect(entry.planes).toBe(1)
      expect(entry.bitCount).toBe(32)
      // A 32bpp DIB entry is a 40-byte header, `w * h * 4` of BGRA, then a 1bpp AND mask whose rows
      // are padded to 4 bytes. Anything else means the entry is truncated or mis-declared.
      const mask = Math.ceil(entry.width / 32) * 4 * entry.height
      expect(entry.length).toBe(40 + entry.width * entry.height * 4 + mask)
      expect(entry.offset + entry.length).toBeLessThanOrEqual(bytes.length)
    }
  })

  it('draws the Cardinal mark in its three known fills', () => {
    // Read off the 64, the largest entry: fine ink detail (the eye, the beak) is a handful of
    // pixels even here, and would all but vanish under antialiasing at 16.
    const entry = readDirectory(bytes).find((e) => e.width === 64)
    const image = readPixels(bytes, entry)

    let inkPixels = 0
    let bodyPixels = 0
    let crescentPixels = 0
    let opaque = 0
    for (let y = 0; y < entry.height; y += 1) {
      for (let x = 0; x < entry.width; x += 1) {
        const px = image.at(x, y)
        // Edge pixels are antialiased against nothing, so only fully-opaque ones carry a fill
        // colour unblended. Those are what get counted.
        if (px.a !== 255) {
          continue
        }
        opaque += 1
        if (isNear(px, INK)) {
          inkPixels += 1
        } else if (isNear(px, BODY)) {
          bodyPixels += 1
        } else if (isNear(px, CRESCENT)) {
          crescentPixels += 1
        }
      }
    }

    // The mark is mostly the crescent, with the bird's body a smaller share and its ink detail
    // smaller still — but all three have to actually be present.
    expect(crescentPixels).toBeGreaterThan(300)
    expect(bodyPixels).toBeGreaterThan(50)
    expect(inkPixels).toBeGreaterThan(5)
    expect(crescentPixels).toBeGreaterThan(bodyPixels)
    expect(inkPixels + bodyPixels + crescentPixels).toBeGreaterThan(opaque * 0.85)
  })

  it('leaves the corners transparent rather than boxing the mark in', () => {
    const entry = readDirectory(bytes).find((e) => e.width === 32)
    const image = readPixels(bytes, entry)
    for (const [x, y] of [
      [0, 0],
      [31, 0],
      [0, 31],
      [31, 31]
    ]) {
      expect(image.at(x, y).a).toBe(0)
    }
  })
})
