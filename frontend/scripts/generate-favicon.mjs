/*
  Generates `public/favicon.ico` AND its backend copy, `../backend/assets/branding/favicon.ico` —
  the icon a browser fetches from `/favicon.ico` on its own.

  Two different things serve an icon here, and only one of them is declared in markup:

  - `index.html` declares `<link rel="icon" href="/_site/current/favicon" />`, which lets a site
    administrator upload an icon of their own. That is the right declaration and is untouched.
  - Every browser ALSO requests the bare `/favicon.ico` root path unprompted, whatever the markup
    says, and `'favicon.ico'` is in `RESERVED_ROOT_FILES` (`backend/core/http/siteRouting.ts`) so
    that request is served this file rather than falling through to the app shell — the backend
    copy, not this one: `core/http/server.ts#registerStaticAssets` resolves it against
    `WIKI.SERVERPATH`, the same committed-source pattern `controllers/site.ts`'s
    `SITE_ASSET_FALLBACKS` already uses for the other branding fallbacks, and for the same reason
    (OpenProject #2611) — `public/favicon.ico` stays for the Vite dev server alone.

  So this file ships regardless, and it has to be the Cardinal mark rather than the icon inherited
  from upstream. Its source of truth is `public/_assets/logo-cardinal.svg` — the same placeholder
  mark the admin chrome draws — so re-run this whenever that changes.

  Rendering goes through Playwright's Chromium: the SVG is drawn into a `<canvas>` at each target
  size and read back as raw RGBA, which needs no PNG decoder on this side. Chromium is a developer-
  machine precondition for THIS script only — the output is committed, so neither `npm run test`
  nor CI ever launches a browser for it. `scripts/generate-favicon.test.js` asserts the committed
  bytes really are the Cardinal mark, and `backend/controllers/site.test.ts` asserts the two
  committed copies stay byte-identical.

  Usage: node scripts/generate-favicon.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = path.join(ROOT, 'public/_assets/logo-cardinal.svg')
const OUT = path.join(ROOT, 'public/favicon.ico')
const BACKEND_OUT = path.join(ROOT, '../backend/assets/branding/favicon.ico')

/**
 * 48 and 32 are what the file this replaces carried. 16 is added because it is the size a browser
 * tab actually asks for, and a purpose-drawn 16 reads better than a downscaled 32. The wider PWA /
 * apple-touch set (192, 512, and their own `<link>` declarations) is deliberately NOT here — it
 * does not exist today and is its own piece of work, not a widening of this one.
 */
const SIZES = [16, 32, 48]

/**
 * Rasterizes the mark at every size in `SIZES`, in one browser.
 *
 * The SVG's own `width`/`height` are rewritten to the target size rather than left at 32 and scaled
 * by `drawImage`: scaling the destination rect would rasterize once at the intrinsic 32 and then
 * resample, so 48 would come out of a 32 render. Rewriting makes Chromium rasterize the vector at
 * the size being asked for.
 *
 * @param {string} svg The mark's source text.
 * @returns {Promise<Map<number, Uint8ClampedArray>>} Top-down RGBA, one entry per size.
 */
async function rasterize(svg) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const rendered = new Map()
    for (const size of SIZES) {
      const sized = svg
        .replace(/\bwidth="\d+"/, `width="${size}"`)
        .replace(/\bheight="\d+"/, `height="${size}"`)
      const rgba = await page.evaluate(
        async ([source, edge]) => {
          const img = new Image(edge, edge)
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = edge
          canvas.height = edge
          const ctx = canvas.getContext('2d')
          ctx.clearRect(0, 0, edge, edge)
          ctx.drawImage(img, 0, 0, edge, edge)
          return Array.from(ctx.getImageData(0, 0, edge, edge).data)
        },
        [sized, size]
      )
      rendered.set(size, Uint8ClampedArray.from(rgba))
    }
    return rendered
  } finally {
    await browser.close()
  }
}

/**
 * One ICO image, as a 32bpp BGRA DIB.
 *
 * PNG-in-ICO would be shorter and every current browser reads it, but a DIB is what the file this
 * replaces used and what every decoder ever written reads, and at these sizes the size difference
 * is a couple of kilobytes. The AND mask is redundant beside an alpha channel for anything modern;
 * it is still filled from alpha rather than zeroed, so a decoder that honours the mask and ignores
 * alpha gets a correct hard-edged silhouette instead of an opaque square.
 *
 * @param {number} size Edge length in pixels.
 * @param {Uint8ClampedArray} rgba Top-down RGBA pixels, `size * size * 4` bytes.
 * @returns {Buffer} BITMAPINFOHEADER + XOR pixels + AND mask.
 */
function encodeDib(size, rgba) {
  const xorStride = size * 4
  const andStride = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  const xor = Buffer.alloc(xorStride * size)
  const and = Buffer.alloc(andStride * size)

  for (let y = 0; y < size; y += 1) {
    // A DIB is stored bottom-up: the last row of the image is the first row on disk.
    const flipped = size - 1 - y
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4
      const to = flipped * xorStride + x * 4
      xor[to] = rgba[from + 2]
      xor[to + 1] = rgba[from + 1]
      xor[to + 2] = rgba[from]
      xor[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) {
        and[flipped * andStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight — XOR and AND stacked, so twice the real height
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression — BI_RGB
  header.writeUInt32LE(xor.length + and.length, 20) // biSizeImage

  return Buffer.concat([header, xor, and])
}

/**
 * Wraps the encoded images in an ICONDIR + one ICONDIRENTRY each.
 *
 * @param {Array<{ size: number, dib: Buffer }>} images
 * @returns {Buffer}
 */
function encodeIco(images) {
  const dir = Buffer.alloc(6 + images.length * 16)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type — 1 is an icon
  dir.writeUInt16LE(images.length, 4)

  let offset = dir.length
  images.forEach(({ size, dib }, index) => {
    const at = 6 + index * 16
    dir.writeUInt8(size, at) // 0 would mean 256; nothing here is that large
    dir.writeUInt8(size, at + 1)
    dir.writeUInt8(0, at + 2) // colours in the palette — none, this is truecolour
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(dib.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += dib.length
  })

  return Buffer.concat([dir, ...images.map(({ dib }) => dib)])
}

const svg = fs.readFileSync(SRC, 'utf8')

let rendered
try {
  rendered = await rasterize(svg)
} catch (err) {
  console.error(`Could not render ${path.relative(ROOT, SRC)}: ${err.message}`)
  console.error("This script needs Playwright's Chromium — run `npm run install-browsers`.")
  process.exit(1)
}

const ico = encodeIco(SIZES.map((size) => ({ size, dib: encodeDib(size, rendered.get(size)) })))
fs.writeFileSync(OUT, ico)
fs.writeFileSync(BACKEND_OUT, ico)
console.log(
  `wrote ${SIZES.join('/')} px to public/favicon.ico and ../backend/assets/branding/favicon.ico ` +
    `(${ico.length.toLocaleString()} B)`
)
