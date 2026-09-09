import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2860 ("Add tabs- and block-namespaced custom properties, Ledger-light defaults"). Same
 * rationale as `cobaltTokens.test.js`/`cobaltDarkTokens.test.js`: `tailwind.css` is plain CSS, not a
 * module anything here can import and read live custom property values off, and there is no
 * compiled stylesheet or real layout engine in this test environment to resolve `var()` cascades
 * against -- asserting against the SOURCE TEXT directly is the established pattern.
 *
 * The full table this suite pins down is `ui-iteration/tabset-block.md`'s. This is a token-existence
 * and token-value suite only: nothing in `blocks/` reads `--tabs-*` yet (Feature #2844, the block's
 * own conversion, is out of this run) -- see `tailwind.css`'s own header comment on the section this
 * covers.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

const tabsSectionStart = source.indexOf('-- Tabset block + shared block custom properties')
const ledgerDarkStart = source.indexOf('body.body--dark {', tabsSectionStart)
const cobaltLightStart = source.indexOf('body.body--cobalt {', tabsSectionStart)
const cobaltDarkStart = source.indexOf('body.body--cobalt.body--dark {', tabsSectionStart)
const elementResetStart = source.indexOf('Element reset for the shared components')

const ledgerLightSource = source.slice(tabsSectionStart, ledgerDarkStart)
const ledgerDarkSource = source.slice(ledgerDarkStart, cobaltLightStart)
const cobaltLightSource = source.slice(cobaltLightStart, cobaltDarkStart)
const cobaltDarkSource = source.slice(cobaltDarkStart, elementResetStart)

describe('the tabset/block token section', () => {
  it('exists, with all four state blocks in order', () => {
    expect(tabsSectionStart).toBeGreaterThan(-1)
    expect(ledgerDarkStart).toBeGreaterThan(tabsSectionStart)
    expect(cobaltLightStart).toBeGreaterThan(ledgerDarkStart)
    expect(cobaltDarkStart).toBeGreaterThan(cobaltLightStart)
    expect(elementResetStart).toBeGreaterThan(cobaltDarkStart)
  })
})

/** Finds `--name: value;` (or a multi-line value up to the next `--` or closing brace) in a slice. */
function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

describe('--tabs-* tokens, one row per ui-iteration/tabset-block.md', () => {
  const rows = {
    border: {
      ledgerLight: '#dbe1ec',
      ledgerDark: '#2a3040',
      cobaltLight: '#dfe5f5',
      cobaltDark: 'rgb(255 255 255 / 0.1)'
    },
    radius: { ledgerLight: '0', cobaltLight: '8px' },
    shadow: { ledgerLight: 'none' },
    'corner-marks': { ledgerLight: 'block', cobaltLight: 'none' },
    'strip-bg': {
      ledgerLight: '#f0f2f7',
      ledgerDark: '#14171f',
      cobaltLight: '#e6edff',
      cobaltDark: '#0e1540'
    },
    'strip-padding': { ledgerLight: '0', cobaltLight: '4px 4px 0' },
    'strip-gap': { ledgerLight: '0', cobaltLight: '4px' },
    'strip-rule': {
      ledgerLight: '1px solid var(--tabs-border)',
      cobaltLight: 'none'
    },
    'tab-padding': { ledgerLight: '9px 16px', cobaltLight: '8px 14px' },
    'tab-radius': { ledgerLight: '0', cobaltLight: '6px 6px 0 0' },
    'tab-rule': {
      ledgerLight: '1px solid var(--tabs-border)',
      cobaltLight: 'none'
    },
    'inactive-fg': {
      ledgerLight: '#4e5d7d',
      ledgerDark: '#9aa6bd',
      cobaltLight: '#4a5580',
      cobaltDark: '#a7b3ea'
    },
    'inactive-icon': {
      ledgerLight: '#64789f',
      ledgerDark: '#8ea6cf',
      cobaltLight: '#5a6699',
      cobaltDark: '#8b98d6'
    },
    'hover-bg': {
      ledgerLight: 'rgb(255 255 255 / 0.6)',
      ledgerDark: 'rgb(255 255 255 / 0.05)',
      cobaltLight: 'rgb(31 79 214 / 0.08)',
      cobaltDark: 'rgb(255 255 255 / 0.08)'
    },
    'hover-fg': {
      ledgerLight: '#38465f',
      ledgerDark: '#e6eaf2',
      cobaltLight: '#1a2038',
      cobaltDark: '#e8ecff'
    },
    'active-fg': {
      ledgerLight: '#c14a52',
      ledgerDark: '#f08287',
      cobaltLight: '#1f4fd6',
      cobaltDark: '#8fb0ff'
    },
    'active-weight': { ledgerLight: '500', cobaltLight: '600' },
    'active-cap': {
      ledgerLight: 'inset 0 2px 0 #e4676b',
      ledgerDark: 'inset 0 2px 0 #f08287',
      cobaltLight: 'inset 0 3px 0 #ff4d5a'
    },
    'focus-ring': {
      ledgerLight: 'inset 0 0 0 2px #e4676b',
      ledgerDark: 'inset 0 0 0 2px #f08287',
      cobaltLight: 'inset 0 0 0 2px #1f4fd6',
      cobaltDark: 'inset 0 0 0 2px #8fb0ff'
    },
    'panel-bg': {
      ledgerLight: '#fff',
      ledgerDark: '#1b1f2a',
      cobaltDark: '#141c4f'
    },
    'panel-padding': { ledgerLight: '18px 20px' }
  }

  it.each(Object.entries(rows))(
    '--tabs-%s resolves correctly in every state it changes for',
    (name, states) => {
      expect(declaredValue(ledgerLightSource, `tabs-${name}`), `--tabs-${name} Ledger light`).toBe(
        states.ledgerLight
      )
      if (states.ledgerDark) {
        expect(declaredValue(ledgerDarkSource, `tabs-${name}`), `--tabs-${name} Ledger dark`).toBe(
          states.ledgerDark
        )
      }
      if (states.cobaltLight) {
        expect(
          declaredValue(cobaltLightSource, `tabs-${name}`),
          `--tabs-${name} Cobalt light`
        ).toBe(states.cobaltLight)
      }
      if (states.cobaltDark) {
        expect(declaredValue(cobaltDarkSource, `tabs-${name}`), `--tabs-${name} Cobalt dark`).toBe(
          states.cobaltDark
        )
      }
    }
  )

  it('leaves shape/geometry rows undeclared past Ledger light when the table marks them "same"', () => {
    for (const name of [
      'radius',
      'shadow',
      'strip-padding',
      'strip-gap',
      'tab-padding',
      'panel-padding'
    ]) {
      expect(ledgerDarkSource, `--tabs-${name} should not be restated for Ledger dark`).not.toMatch(
        new RegExp(`--tabs-${name}:`)
      )
    }
  })
})

describe('the --tabs-border Cobalt-dark divergence from the generic hairline token', () => {
  it('is NOT the same value as --color-hairline-dark under body.body--cobalt.body--dark', () => {
    // -> The ORIGINAL (#2771) body.body--cobalt.body--dark block, which precedes this section
    const originalDarkStart = source.indexOf('body.body--cobalt.body--dark {')
    const originalDarkEnd = source.indexOf('\n}', originalDarkStart)
    const originalDarkSource = source.slice(originalDarkStart, originalDarkEnd)

    expect(declaredValue(cobaltDarkSource, 'tabs-border')).toBe('rgb(255 255 255 / 0.1)')
    expect(declaredValue(originalDarkSource, 'color-hairline-dark')).toBe('rgb(255 255 255 / 0.08)')
  })
})
