import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/*
  Neither jsdom nor happy-dom resolves a real cascade against `tailwind.css`, so this reads the
  `<style>` block back as text instead. That is the level these assertions sit at: whether the block
  reaches for the token layer at all, not what any one token resolves to -- `cobaltTokens.test.js`
  owns that, and `Login.darkMode.test.js` the live light/dark cascade.
*/

const pagesDir = dirname(fileURLToPath(import.meta.url))
const srcDir = dirname(pagesDir)

/** @param {string} dir directory containing the SFC, relative to `src/` */
function compileStyles(dir, fileName) {
  const source = readFileSync(join(srcDir, dir, fileName), 'utf8')
  const block = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  expect(block, `${fileName} has a style block`).toBeTruthy()
  return block[1]
}

/**
 * Merged across every rule that names the selector: a shared `&::before, &::after {…}` block plus
 * that selector's own dedicated rule are TWO CSS rules, both of which apply. Keys are literal CSS
 * property names (`border-top`, not `borderTop`).
 *
 * @param {string} selector the exact, whole selector as the stylesheet writes it
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

  /* `--corner-marks` is `block` (a no-op) under Ledger and `none` under Cobalt. */
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

  it('carries no literal hex color left over from the SCSS variables it replaced', () => {
    // -> A `#`-prefixed literal in any of these, rather than a `var(--color-*)`, bakes one
    //    aesthetic's palette in and leaves the other theme unable to override it.
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
