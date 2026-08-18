import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Structural regression coverage for the vendored self-hosted font assets under
 * `frontend/public/_assets/fonts/`. These are static binary/CSS assets, not application logic, so
 * this is a filesystem/parse-level check rather than a unit test of behavior: it exists to catch
 * the two failure modes that matter for a vendored asset set — (1) a woff2 a CSS file references
 * silently going missing or corrupt (e.g. an accidental `git rm`, a bad copy), and (2) an
 * `@font-face` block regressing to the exact bug found and fixed in `rubik.css` by task 715: a
 * missing `font-weight`/`font-style` declaration, which makes the browser only ever match that face
 * for `font-weight: normal` and silently fail to use it for bold text.
 */

// vitest's `test.include` (vitest.config.js) is `src/**/*.test.js`, and its `test` block sets no
// `root`/`dir` override, so vitest's process cwd is `frontend/` (where `npx vitest` is invoked from
// per the workspace's own convention) - resolving from there, not from `import.meta.url`, because at
// static module-eval time vitest/vite-node gives `import.meta.url` a synthetic `http://localhost/@fs/…`
// origin rather than a real `file:` URL, which `fileURLToPath` rejects.
const FONTS_DIR = path.join(process.cwd(), 'public', '_assets', 'fonts')

const FAMILIES = [
  { dir: 'roboto', css: 'roboto.css', family: 'Roboto' },
  { dir: 'rubik', css: 'rubik.css', family: 'Rubik' },
  { dir: 'inter', css: 'inter.css', family: 'Inter' },
  { dir: 'montserrat', css: 'montserrat.css', family: 'Montserrat' },
  { dir: 'opensans', css: 'opensans.css', family: 'Open Sans' },
  { dir: 'tajawal', css: 'tajawal.css', family: 'Tajawal' }
]

function parseFontFaces(css) {
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || []
  return blocks.map((block) => {
    const urls = [...block.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2])
    return {
      block,
      family: block.match(/font-family:\s*'([^']+)'/)?.[1],
      style: block.match(/font-style:\s*([^;]+);/)?.[1]?.trim(),
      weight: block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim(),
      unicodeRange: block.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim(),
      urls
    }
  })
}

function readWoff2Magic(assetUrl) {
  // asset urls are absolute app paths like /_assets/fonts/inter/inter-all-300.woff2
  const relative = assetUrl.replace(/^\/_assets\/fonts\//, '')
  const filePath = path.join(FONTS_DIR, relative)
  expect(existsSync(filePath), `referenced font file missing on disk: ${filePath}`).toBe(true)
  const fd = readFileSync(filePath)
  return { size: fd.length, magic: fd.subarray(0, 4).toString('ascii') }
}

describe('vendored font assets', () => {
  for (const { dir, css, family } of FAMILIES) {
    describe(family, () => {
      const cssPath = path.join(FONTS_DIR, dir, css)

      it(`ships a ${css} following the @font-face convention`, () => {
        expect(existsSync(cssPath), `missing ${cssPath}`).toBe(true)
      })

      const content = existsSync(cssPath) ? readFileSync(cssPath, 'utf-8') : ''
      const faces = parseFontFaces(content)

      it('declares at least one @font-face block', () => {
        expect(faces.length).toBeGreaterThan(0)
      })

      it('every @font-face names the right family and declares style + weight', () => {
        for (const face of faces) {
          expect(face.family, face.block).toBe(family)
          // Regression guard for the rubik.css bug: an @font-face with no font-weight only ever
          // matches `font-weight: normal`, silently dropping bold text to the next font in the stack.
          expect(face.weight, `missing font-weight in block:\n${face.block}`).toBeTruthy()
          expect(face.style, `missing font-style in block:\n${face.block}`).toBeTruthy()
        }
      })

      it('every referenced woff2 file exists on disk and is a valid woff2', () => {
        for (const face of faces) {
          for (const url of face.urls) {
            const { size, magic } = readWoff2Magic(url)
            expect(magic).toBe('wOF2')
            expect(size).toBeGreaterThan(1000)
          }
        }
      })
    })
  }

  it('rubik.css variable font faces cover the full weight axis (300 900), not just normal', () => {
    const content = readFileSync(path.join(FONTS_DIR, 'rubik', 'rubik.css'), 'utf-8')
    const faces = parseFontFaces(content)
    for (const face of faces) {
      expect(face.weight).toBe('300 900')
    }
  })

  it('rubik, inter, montserrat and opensans cover at minimum latin + latin-ext', () => {
    // rubik declares real unicode-range per subset - assert both are present explicitly.
    const rubik = readFileSync(path.join(FONTS_DIR, 'rubik', 'rubik.css'), 'utf-8')
    expect(rubik).toMatch(/latin-ext[\s\S]*?unicode-range:\s*U\+0100-024F/)
    expect(rubik).toMatch(/\/\* latin \*\/[\s\S]*?unicode-range:\s*U\+0000-00FF/)

    // inter/montserrat/opensans were vendored as merged (non-unicode-range-split) files whose
    // subset composition is documented in each @font-face's leading comment, mirroring the
    // pre-existing roboto.css convention.
    for (const dir of ['inter', 'montserrat', 'opensans']) {
      const content = readFileSync(path.join(FONTS_DIR, dir, `${dir}.css`), 'utf-8')
      expect(content, dir).toMatch(/latin-ext/)
      expect(content, dir).toMatch(/[^-]latin[^-]/)
    }
  })

  it('tajawal has no latin-ext subset upstream (documented variance, not a bug)', () => {
    const content = readFileSync(path.join(FONTS_DIR, 'tajawal', 'tajawal.css'), 'utf-8')
    // The subset-composition token in each face's header comment (mirroring roboto.css's own
    // "vietnamese_latin-ext_latin_..." convention) must be exactly "arabic_latin" - not
    // "arabic_latin_latin-ext" - confirming no latin-ext file was actually vendored. This is
    // deliberately not a blunt "does not contain the substring latin-ext" check: the same comment
    // explains the gap in prose ("No latin-ext instance exists upstream"), which legitimately
    // contains that substring.
    const subsetTokens = [...content.matchAll(/\/\* tajawal-\S+ - (\S+)\./g)].map((m) => m[1])
    expect(subsetTokens.length).toBeGreaterThan(0)
    for (const token of subsetTokens) {
      expect(token).toBe('arabic_latin')
    }
    expect(content).toMatch(/docs\/variances\.md/)
  })
})
