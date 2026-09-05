// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// happy-dom fetches a real `<link rel="stylesheet">`'s `href` as soon as it's appended to the
// document (`DefaultBrowserSettings.disableCSSFileLoading === false`) -- there is no dev server
// behind `/_assets/fonts/...` in this test run, so left on it just logs a stream of aborted-fetch
// `NetworkError`s per assertion below. `disableCSSFileLoading` alone swaps that for a `load`-disabled
// `NotSupportedError` instead, still logged; `handleDisabledFileLoadingAsSuccess` is what actually
// quiets it, by making the disabled load resolve like a normal (empty) stylesheet instead of firing
// an error. `applyFonts()`'s own DOM-shape assertions (which id/data attribute got set, what the href
// string is) never depended on the fetch actually completing either way.

import { afterEach, describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { applyFonts } from './fonts.js'

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
  { dir: 'barlow', css: 'barlow.css', family: 'Barlow' },
  { dir: 'barlow-condensed', css: 'barlow-condensed.css', family: 'Barlow Condensed' },
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

  /*
   * Barlow and Barlow Condensed are the app's own design language (Cardinal), and the pair has to
   * stay a pair: `helpers/fonts.js` links the condensed sheet as the `barlow` entry's `display`
   * companion, so a Barlow vendored without its companion would leave every heading falling back to
   * a system condensed face with nothing to say so.
   */
  it('barlow ships the four weights the interface sets body copy and controls in', () => {
    const content = readFileSync(path.join(FONTS_DIR, 'barlow', 'barlow.css'), 'utf-8')
    const weights = parseFontFaces(content).map((face) => face.weight)
    expect(weights.sort()).toEqual(['400', '500', '600', '700'])
  })

  it('barlow-condensed ships the three weights headings and chrome labels are set in', () => {
    const content = readFileSync(
      path.join(FONTS_DIR, 'barlow-condensed', 'barlow-condensed.css'),
      'utf-8'
    )
    const faces = parseFontFaces(content)
    expect(faces.map((face) => face.weight).sort()).toEqual(['500', '600', '700'])
    for (const face of faces) {
      expect(face.family).toBe('Barlow Condensed')
    }
  })

  it('neither Barlow covers cyrillic or greek upstream, so both stop at vietnamese_latin-ext_latin', () => {
    // Not a gap to fix: Google publishes no cyrillic/greek instance of either family. Text in those
    // scripts falls through the `--font-sans` / `--font-display` stacks to a system face, which is
    // the same thing that happens today for any script a vendored font does not cover.
    for (const dir of ['barlow', 'barlow-condensed']) {
      const content = readFileSync(path.join(FONTS_DIR, dir, `${dir}.css`), 'utf-8')
      const subsetTokens = [
        ...content.matchAll(new RegExp(`\\/\\* ${dir}-\\S+ - (\\S+) `, 'g'))
      ].map((m) => m[1])
      expect(subsetTokens.length, dir).toBeGreaterThan(0)
      for (const token of subsetTokens) {
        expect(token, dir).toBe('vietnamese_latin-ext_latin')
      }
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

describe('applyFonts() (runtime baseFont / contentFont loader)', () => {
  afterEach(() => {
    document.querySelectorAll('link[data-theme-font]').forEach((el) => el.remove())
    document.querySelector('#theme-content-font')?.remove()
    document.documentElement.style.removeProperty('--font-sans')
  })

  it('links the stylesheet and sets --font-sans on the root for a real baseFont', () => {
    applyFonts('inter', 'user')

    const link = document.querySelector('link[data-theme-font="inter"]')
    expect(link).not.toBeNull()
    expect(link.rel).toBe('stylesheet')
    expect(link.href).toContain('/_assets/fonts/inter/inter.css')

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain("'Inter'")
  })

  it('scopes --font-content under a .page-contents style block, not the root', () => {
    applyFonts('user', 'montserrat')

    const styleEl = document.querySelector('#theme-content-font')
    expect(styleEl).not.toBeNull()
    expect(styleEl.tagName).toBe('STYLE')
    expect(styleEl.textContent).toContain('.page-contents')
    expect(styleEl.textContent).toContain("'Montserrat'")

    // Never written to the root as an app-wide override
    expect(document.documentElement.style.getPropertyValue('--font-content')).toBe('')
  })

  it('dedupes the stylesheet link when baseFont and contentFont match', () => {
    applyFonts('rubik', 'rubik')

    const links = document.querySelectorAll('link[data-theme-font="rubik"]')
    expect(links.length).toBe(1)
  })

  it('links a separate stylesheet for each font when baseFont and contentFont differ', () => {
    applyFonts('roboto', 'tajawal')

    expect(document.querySelectorAll('link[data-theme-font="roboto"]').length).toBe(1)
    expect(document.querySelectorAll('link[data-theme-font="tajawal"]').length).toBe(1)
    expect(document.querySelectorAll('link[data-theme-font]').length).toBe(2)
  })

  /*
   * The display companion: `barlow` is the only catalog entry that declares one, and it is what
   * makes Cardinal's "Barlow Condensed headings over Barlow body" a single admin choice rather than
   * two that can be got wrong independently.
   */
  it("links the base font's display companion and writes --font-display", () => {
    applyFonts('barlow', 'barlow')

    expect(document.querySelectorAll('link[data-theme-font="barlow"]').length).toBe(1)
    const companion = document.querySelector('link[data-theme-font="barlow-display"]')
    expect(companion).not.toBeNull()
    expect(companion.href).toContain('/_assets/fonts/barlow-condensed/barlow-condensed.css')

    const display = document.documentElement.style.getPropertyValue('--font-display')
    expect(display).toContain("'Barlow Condensed'")
    // -> Falls back through CONDENSED faces, so a heading does not reflow to normal width and back
    expect(display).toContain('Roboto Condensed')
  })

  it('clears --font-display for a base font with no display companion', () => {
    applyFonts('barlow', 'user')
    applyFonts('inter', 'user')

    expect(document.documentElement.style.getPropertyValue('--font-display')).toBe('')
    expect(document.querySelector('link[data-theme-font="barlow-display"]')).toBeNull()
  })

  it('never links a display companion for contentFont alone -- headings are chrome, not content', () => {
    applyFonts('inter', 'barlow')

    expect(document.querySelectorAll('link[data-theme-font="barlow"]').length).toBe(1)
    expect(document.querySelector('link[data-theme-font="barlow-display"]')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--font-display')).toBe('')
  })

  it('treats baseFont "user" as no override: removes --font-sans, links nothing for it', () => {
    applyFonts('inter', 'user')
    applyFonts('user', 'user')

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('')
    expect(document.querySelectorAll('link[data-theme-font]').length).toBe(0)
  })

  it('treats contentFont "user" as no override: removes the .page-contents style block', () => {
    applyFonts('user', 'inter')
    applyFonts('user', 'user')

    expect(document.querySelector('#theme-content-font')).toBeNull()
  })

  it('never requests a stylesheet literally named "user"', () => {
    applyFonts('user', 'user')

    expect(document.querySelectorAll('link[data-theme-font]').length).toBe(0)
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      expect(link.href).not.toContain('/fonts/user/')
    }
  })

  it('replaces rather than duplicates links and the content-font style block on repeated calls', () => {
    applyFonts('inter', 'montserrat')
    applyFonts('opensans', 'roboto')

    expect(document.querySelectorAll('link[data-theme-font]').length).toBe(2)
    expect(document.querySelectorAll('link[data-theme-font="inter"]').length).toBe(0)
    expect(document.querySelectorAll('link[data-theme-font="opensans"]').length).toBe(1)
    expect(document.querySelectorAll('#theme-content-font').length).toBe(1)
    expect(document.querySelector('#theme-content-font').textContent).toContain("'Roboto'")
  })
})
