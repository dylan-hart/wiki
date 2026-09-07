import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as sass from 'sass'

/*
  `Login.vue`'s `.auth` stylesheet against the Cobalt token layer (OpenProject #2779).

  `tailwind.css` -- where `--color-*`/`--corner-marks`/`--shadow-primary` actually get their
  per-aesthetic values -- is plain CSS with no compiled module this file can import and resolve a
  live cascade against (see `css/cobaltTokens.test.js`'s identical note), and neither jsdom nor
  happy-dom runs a real cascade/layout engine either way. So, following `editorScreenChrome.test.js`'s
  established pattern, this compiles `Login.vue`'s own `<style lang="scss">` block through the same
  Sass pipeline `vite.config.js`/`vitest.config.js` both apply and reads the emitted declarations
  back -- which is exactly the level this task's own gap sits at: whether the block reaches for the
  token layer at all, not what any one token currently resolves to (that is `cobaltTokens.test.js`'s
  job, and `Login.darkMode.test.js`'s for the live light/dark cascade).
*/

const pagesDir = dirname(fileURLToPath(import.meta.url))
const srcDir = dirname(pagesDir)

/**
 * One SFC's `<style lang="scss">` block, compiled the way the app compiles it.
 *
 * @param {string} dir directory containing the SFC, relative to `src/`
 * @param {string} fileName the SFC itself
 * @returns {string} the compiled CSS
 */
function compileStyles(dir, fileName) {
  const source = readFileSync(join(srcDir, dir, fileName), 'utf8')
  const block = source.match(/<style[^>]*lang="scss"[^>]*>([\s\S]*?)<\/style>/)
  expect(block, `${fileName} has a scss style block`).toBeTruthy()
  return sass.compileString(
    `@use '@/css/_theme.scss' as *;\n@use '@/css/_palette.scss' as *;\n${block[1]}`,
    {
      importers: [
        {
          findFileUrl(url) {
            return url.startsWith('@/') ? new URL(`file://${join(srcDir, url.slice(2))}`) : null
          }
        }
      ]
    }
  ).css
}

/**
 * Every declaration one selector carries, as a `property: value` map -- merged across every rule
 * that names it (a Sass `&::before, &::after {…}` shared block plus that selector's own dedicated
 * rule compile to TWO separate CSS rules, both of which apply). Keys are literal CSS property names
 * (`border-top`, not `borderTop`). See `editorScreenChrome.test.js`'s identical single-rule helper
 * for why comments are stripped before the split.
 *
 * @param {string} css
 * @param {string} selector the exact, whole selector as Sass emits it
 * @returns {Record<string, string>}
 */
function declarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\n|,\\s*)${escaped}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'g')
  const merged = {}
  let matchCount = 0
  let match
  while ((match = re.exec(css))) {
    matchCount++
    for (const line of match[3]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const at = line.indexOf(':')
      merged[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  expect(matchCount, `${selector} is emitted`).toBeGreaterThan(0)
  return merged
}

describe('the login/auth screen’s own chrome (OpenProject #2779)', () => {
  const css = compileStyles('pages', 'Login.vue')

  it('draws the column and its text off the surface/text-body tokens, in both themes', () => {
    expect(declarations(css, '.auth')).toMatchObject({
      'background-color': 'var(--color-surface)',
      color: 'var(--color-text-body)'
    })
    expect(declarations(css, '.body--dark .auth')).toEqual({
      'background-color': 'var(--color-dark-6)',
      color: 'var(--color-text-dark)'
    })
  })

  it('takes the wordmark, lead, subtitle, notice and hint off the generic text tokens', () => {
    expect(declarations(css, '.auth-site-title').color).toBe('var(--color-ink)')
    expect(declarations(css, '.body--dark .auth-site-title').color).toBe('var(--color-text-dark)')
    expect(declarations(css, '.auth-lead').color).toBe('var(--color-text-secondary)')
    expect(declarations(css, '.body--dark .auth-lead').color).toBe(
      'var(--color-text-secondary-dark)'
    )
    expect(declarations(css, '.auth-subtitle').color).toBe('var(--color-text-secondary)')
    expect(declarations(css, '.auth-notice').color).toBe('var(--color-slate)')
    expect(declarations(css, '.body--dark .auth-notice').color).toBe('var(--color-text-dark)')
    expect(declarations(css, '.auth-hint').color).toBe('var(--color-text-secondary)')
  })

  it('paints the background pane off the tint tokens, in both themes', () => {
    expect(declarations(css, '.auth-bg')['background-color']).toBe('var(--color-tint)')
    expect(declarations(css, '.body--dark .auth-bg')['background-color']).toBe(
      'var(--color-dark-4)'
    )
  })

  /*
   * `--corner-marks` (#2767) is `block` (a no-op) under Ledger and `none` under Cobalt -- neither
   * mockup this task diffs against draws a registration mark on anything.
   */
  it('gates the blueprint corner marks on --corner-marks, in the accent-fill color', () => {
    expect(declarations(css, '.auth-marks::before')).toMatchObject({
      display: 'var(--corner-marks)',
      'border-top': '1px solid var(--color-accent-fill)',
      'border-inline-start': '1px solid var(--color-accent-fill)'
    })
    expect(declarations(css, '.auth-marks::after')).toMatchObject({
      display: 'var(--corner-marks)',
      'border-bottom': '1px solid var(--color-accent-fill)',
      'border-inline-end': '1px solid var(--color-accent-fill)'
    })
  })

  /*
   * `--shadow-primary` (#2767/#2772) was declared but had no consumer anywhere in the app until this
   * task -- `none` under Ledger, the mockups' own glow under Cobalt.
   */
  it('gives every primary action the --shadow-primary glow through .auth-cta', () => {
    expect(declarations(css, '.auth-cta')['box-shadow']).toBe('var(--shadow-primary)')
  })

  it('carries no literal hex color left over from the SCSS variables it replaced', () => {
    // -> `.auth`, `.auth-site-title`, `.auth-lead`, `.auth-subtitle`, `.auth-notice`, `.auth-hint`,
    //    `.auth-marks` and `.auth-bg` are the selectors this task converted; a `#`-prefixed literal
    //    inside any of them (rather than one of this file's own `var(--color-*)` writes) would mean a
    //    `$`-prefixed SCSS variable survived the conversion and baked a Ledger literal in at compile
    //    time again.
    for (const selector of [
      '.auth',
      '.body--dark .auth',
      '.auth-site-title',
      '.body--dark .auth-site-title',
      '.auth-lead',
      '.body--dark .auth-lead',
      '.auth-subtitle',
      '.auth-notice',
      '.body--dark .auth-notice',
      '.auth-hint',
      '.auth-bg',
      '.body--dark .auth-bg'
    ]) {
      const decls = Object.values(declarations(css, selector)).join(' ')
      expect(decls, selector).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })
})

describe('the TFA screens’ own chrome (OpenProject #2779)', () => {
  const css = compileStyles('components', 'AuthTfaScreens.vue')

  it('draws the digit boxes and the QR frame off the generic tokens, in both themes', () => {
    expect(declarations(css, '.auth-otp :deep(.otp-input)')).toMatchObject({
      border: '1px solid var(--color-hairline)',
      color: 'var(--color-ink)'
    })
    expect(declarations(css, '.auth-otp :deep(.otp-input:focus)')['border-color']).toBe(
      'var(--color-accent-fill)'
    )
    expect(declarations(css, '.auth-qr')).toMatchObject({
      border: '1px solid var(--color-hairline)',
      'background-color': 'var(--color-surface)'
    })
    expect(declarations(css, ':global(body.body--dark .auth-otp .otp-input)')['border-color']).toBe(
      'var(--color-hairline-dark)'
    )
    expect(declarations(css, ':global(body.body--dark .auth-qr)')['border-color']).toBe(
      'var(--color-hairline-dark)'
    )
  })
})
