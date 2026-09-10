import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2860 ("Add tabs- and block-namespaced custom properties, Ledger-light defaults"). Same
 * rationale as `cobaltTokens.test.js`/`cobaltDarkTokens.test.js`: asserting against `tailwind.css`'s
 * SOURCE TEXT directly, since there is no compiled stylesheet or layout engine in this test
 * environment to resolve a real `var()` cascade against.
 *
 * The `--block-*` namespace this suite pins down covers exactly what `ui-iteration/blocks.md`'s
 * "Ground rules (every block)" and "Shared fragments" sections describe as reusable across every
 * block -- not each block's own per-block specifics, which stay Feature #2844's job (out of this
 * run) when it converts each block in turn. Nothing in `blocks/` reads these yet.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

const sectionStart = source.indexOf('-- Tabset block + shared block custom properties')
const ledgerDarkStart = source.indexOf('body.body--dark {', sectionStart)
const cobaltLightStart = source.indexOf('body.body--cobalt {', sectionStart)
const cobaltDarkStart = source.indexOf('body.body--cobalt.body--dark {', sectionStart)
const elementResetStart = source.indexOf('Element reset for the shared components')

const ledgerLightSource = source.slice(sectionStart, ledgerDarkStart)
const ledgerDarkSource = source.slice(ledgerDarkStart, cobaltLightStart)
const cobaltLightSource = source.slice(cobaltLightStart, cobaltDarkStart)
const cobaltDarkSource = source.slice(cobaltDarkStart, elementResetStart)

/** Finds `--name: value;` (or a multi-line value up to the next `--` or closing brace) in a slice. */
function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

describe('--block-* Ledger-light defaults (ground-rules token layer)', () => {
  const ledgerDefaults = {
    border: 'var(--color-hairline)',
    radius: 'var(--radius-card)',
    'tile-radius': 'var(--radius-control)',
    'corner-marks': 'var(--corner-marks)',
    'mark-color': 'var(--color-slate-soft)',
    bg: 'var(--color-white)',
    'tint-bg': 'var(--color-tint-alt)',
    'caption-fg': 'var(--color-text-secondary)',
    'eyebrow-fg': 'var(--color-text-caption)',
    'accent-fill': 'var(--color-accent-fill)',
    'accent-fg': 'var(--color-accent)',
    'link-fg': 'var(--color-accent-strong)',
    'error-border': '1px dashed var(--block-accent-fill)',
    'error-bg': 'var(--block-bg)',
    'error-radius': 'var(--block-tile-radius)'
  }

  it.each(Object.entries(ledgerDefaults))(
    '--block-%s has its Ledger-light default',
    (name, value) => {
      expect(declaredValue(ledgerLightSource, `block-${name}`), `--block-${name}`).toBe(value)
    }
  )
})

describe('--block-* Ledger-dark overrides', () => {
  const ledgerDark = {
    border: 'var(--color-hairline-dark)',
    bg: 'var(--color-dark-3)',
    'tint-bg': 'var(--color-dark-2)',
    'caption-fg': 'var(--color-text-secondary-dark)',
    'eyebrow-fg': 'var(--color-text-caption-dark)',
    'accent-fill': 'var(--color-accent-dark)',
    'accent-fg': 'var(--color-accent-dark)',
    // -> OpenProject #2905: restated because --block-accent-fill is restated on this same
    //    selector -- otherwise its nested var(--block-accent-fill) would keep resolving against
    //    :root's Ledger-light fill (the same cascade bug class #2886 fixed for --tabs-strip-rule).
    'error-border': '1px dashed var(--block-accent-fill)'
  }

  it.each(Object.entries(ledgerDark))('--block-%s is restated for Ledger dark', (name, value) => {
    expect(declaredValue(ledgerDarkSource, `block-${name}`), `--block-${name} Ledger dark`).toBe(
      value
    )
  })

  it('leaves shape tokens and --block-link-fg undeclared (dark-invariant, or genuinely unspecified)', () => {
    for (const name of ['radius', 'tile-radius', 'corner-marks', 'mark-color', 'link-fg']) {
      expect(ledgerDarkSource, `--block-${name} should not be restated`).not.toMatch(
        new RegExp(`--block-${name}:`)
      )
    }
  })
})

describe('--block-* Cobalt-light overrides', () => {
  it('restates only --block-tint-bg and --block-error-bg', () => {
    expect(declaredValue(cobaltLightSource, 'block-tint-bg')).toBe('var(--color-tint)')
    expect(declaredValue(cobaltLightSource, 'block-error-bg')).toBe('var(--color-accent-wash)')

    for (const name of [
      'border',
      'radius',
      'tile-radius',
      'corner-marks',
      'mark-color',
      'bg',
      'caption-fg',
      'eyebrow-fg',
      'accent-fill',
      'accent-fg',
      'link-fg',
      'error-border',
      'error-radius'
    ]) {
      expect(
        cobaltLightSource,
        `--block-${name} should not be restated for Cobalt light`
      ).not.toMatch(new RegExp(`--block-${name}:`))
    }
  })
})

describe('--block-* Cobalt-dark overrides', () => {
  it('restates --block-border, --block-tint-bg and re-points --block-accent-fill', () => {
    // -> OpenProject #2912: re-derived from the card hue as a solid hex, not the flat white-alpha
    //    overlay this used to be -- still its own literal override, not the generic alias.
    expect(declaredValue(cobaltDarkSource, 'block-border')).toBe('#3143b9')
    expect(declaredValue(cobaltDarkSource, 'block-tint-bg')).toBe('var(--color-dark-3-5)')
    expect(declaredValue(cobaltDarkSource, 'block-accent-fill')).toBe('var(--color-accent-fill)')
  })

  it('restates --block-error-border alongside --block-accent-fill (OpenProject #2905)', () => {
    // -> Same reasoning as the Ledger-dark case: --block-accent-fill is restated on this exact
    //    selector, so --block-error-border must be too, or its nested var() would keep resolving
    //    against :root's Ledger-light fill instead of this block's own re-pointed value.
    expect(declaredValue(cobaltDarkSource, 'block-error-border')).toBe(
      '1px dashed var(--block-accent-fill)'
    )
  })

  it('re-points --block-accent-fill back to the un-lightened fill, undoing the generic dark rule', () => {
    // -> Without this override, Cobalt dark would inherit the generic body.body--dark value
    //    (var(--color-accent-dark)) and draw the lightened Ledger-dark tone instead of staying bright.
    expect(declaredValue(ledgerDarkSource, 'block-accent-fill')).toBe('var(--color-accent-dark)')
    expect(declaredValue(cobaltDarkSource, 'block-accent-fill')).not.toBe(
      'var(--color-accent-dark)'
    )
  })
})

describe('exact-value cross-check against the source docs (ui-iteration/blocks.md)', () => {
  /**
   * Resolves a `--color-*`/`--radius-*` alias chain in the FULL source against one aesthetic/mode,
   * by preferring the most specific matching block. Kept intentionally simple (one alias hop) since
   * every `--block-*` default above is exactly one `var()` away from a literal.
   */
  function literalFor(colorToken, { dark, cobalt } = {}) {
    const blocks = []
    if (cobalt && dark) {
      blocks.push(
        source.slice(
          source.indexOf('body.body--cobalt.body--dark {'),
          source.indexOf('Element reset')
        )
      )
    }
    if (cobalt) {
      blocks.push(
        source.slice(
          source.indexOf('body.body--cobalt {'),
          source.indexOf('body.body--cobalt.body--dark {')
        )
      )
    }
    if (dark) {
      blocks.push(
        source.slice(source.indexOf('body.body--dark {'), source.indexOf('body.body--cobalt {'))
      )
    }
    blocks.push(source)
    for (const block of blocks) {
      const value = declaredValue(block, colorToken)
      if (value !== undefined) {
        return value
      }
    }
    return undefined
  }

  it('--block-border resolves to the exact hairline blocks.md specifies, in each state', () => {
    expect(literalFor('color-hairline')).toBe('#dbe1ec')
    expect(literalFor('color-hairline-dark')).toBe('#2a3040')
    expect(literalFor('color-hairline', { cobalt: true })).toBe('#dfe5f5')
    // -> Cobalt dark is the literal override (#3143b9, OpenProject #2912), not this generic alias
  })

  it('--block-mark-color matches the 7px corner-mark color PageHeader.vue already draws', () => {
    expect(literalFor('color-slate-soft')).toBe('#64789f')
  })

  it('--block-error-bg (Cobalt) matches the exact accent-wash blocks.md gives errorBox', () => {
    expect(literalFor('color-accent-wash', { cobalt: true })).toBe('#ffe9eb')
    expect(literalFor('color-accent-wash', { cobalt: true, dark: true })).toBe(
      'rgb(255 77 90 / 0.16)'
    )
  })
})
