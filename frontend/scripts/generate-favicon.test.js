/*
  Guards the committed `public/favicon.ico` — the icon a browser fetches from the bare
  `/favicon.ico` root path on its own, whatever `index.html` declares.

  This reads the bytes rather than re-running `generate-favicon.mjs`: the generator needs
  Playwright's Chromium, and the whole point of committing the output is that nothing downstream
  of it does. What is asserted is that the file IS the Cardinal mark — its two fills are read out
  of `public/_assets/logo-cardinal.svg` rather than hardcoded here, so re-colouring the mark
  without re-rendering the icon fails as a mismatch instead of passing on a stale render.

  Note for anyone verifying by hand: the icon this replaced was also 15,086 bytes, because it also
  carried 16/32/48 at 32bpp in an uncompressed DIB, so the container layout is byte-for-byte the
  same size. A size check tells you nothing here; the pixels are the only real evidence.
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICO = path.join(ROOT, 'public/favicon.ico')
const SVG = path.join(ROOT, 'public/_assets/logo-cardinal.svg')

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

const fills = [...fs.readFileSync(SVG, 'utf8').matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1])

describe('public/favicon.ico', () => {
  it('is an icon resource carrying the sizes a browser and a desktop shortcut ask for', () => {
    expect(bytes.readUInt16LE(0)).toBe(0) // reserved
    expect(bytes.readUInt16LE(2)).toBe(1) // type: icon, not cursor

    const entries = readDirectory(bytes)
    expect(entries.map((e) => e.width).sort((a, b) => a - b)).toEqual([16, 32, 48])
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

  it('draws the Cardinal mark in the two fills its own source declares', () => {
    // Three paths, two distinct colours: the crescent body and the ink of the head and beak.
    expect(new Set(fills).size).toBe(2)
    const [ink, body] = [parseHex(fills[0]), parseHex(fills[1])]

    // Read off the 48, the largest of the three: the head and the beak are thin triangles, so at 16
    // barely a pixel of ink survives antialiasing and a count there would prove nothing.
    const entry = readDirectory(bytes).find((e) => e.width === 48)
    const image = readPixels(bytes, entry)

    let inkPixels = 0
    let bodyPixels = 0
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
        if (isNear(px, ink)) {
          inkPixels += 1
        }
        if (isNear(px, body)) {
          bodyPixels += 1
        }
      }
    }

    // The mark is mostly the crescent, with the head and beak a small ink minority — but both have
    // to actually be there, and between them account for nearly every solid pixel.
    expect(bodyPixels).toBeGreaterThan(300)
    expect(inkPixels).toBeGreaterThan(15)
    expect(bodyPixels).toBeGreaterThan(inkPixels)
    expect(inkPixels + bodyPixels).toBeGreaterThan(opaque * 0.9)
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
