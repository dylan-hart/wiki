import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { contrastRatio, WCAG_AA_CONTRAST } from '../helpers/accessibility.js'

/**
 * OpenProject #2771 ("Cobalt dark token block in tailwind.css, scoped to body.body--cobalt.body--
 * dark"). Same rationale as `cobaltTokens.test.js`: `tailwind.css` is plain CSS with no compiled
 * stylesheet or layout engine in this test environment, so the established pattern is asserting
 * against the SOURCE TEXT directly.
 *
 * This suite checks:
 *   1. the `body.body--cobalt.body--dark` block exists, layered after the light block;
 *   2. every Ledger "-dark"-suffixed / `--color-dark-N` ramp token the block restates carries its
 *      Cobalt-dark value, distinct from Ledger's own dark value;
 *   3. every plain Cobalt aesthetic token the block restates carries its dark value, distinct from
 *      its own Cobalt-light value;
 *   4. no `--q-*` admin-configurable brand color is overridden here either (same boundary #2767
 *      drew for light);
 *   5. no shape token (radii, corner marks, header banner geometry) is redeclared;
 *   6. the restated text/surface pairs clear WCAG AA.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

const lightBlockStart = source.indexOf('body.body--cobalt {')
const darkBlockStart = source.indexOf('body.body--cobalt.body--dark {')
const darkBlockEnd = darkBlockStart === -1 ? -1 : source.indexOf('\n}', darkBlockStart)
const darkSource = darkBlockStart === -1 ? '' : source.slice(darkBlockStart, darkBlockEnd)

describe('body.body--cobalt.body--dark block', () => {
  it('exists in tailwind.css, after the light body.body--cobalt block', () => {
    expect(lightBlockStart).toBeGreaterThan(-1)
    expect(darkBlockStart).toBeGreaterThan(lightBlockStart)
  })
})

/** Finds `--name: value;` (or a multi-line value up to the next `--` or closing brace) in a slice. */
function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

describe('Ledger dark-suffixed / ramp tokens, restated for Cobalt dark', () => {
  const rampTokens = {
    dark: { ledger: '#14171f', cobalt: '#0a0f2c' },
    'dark-2': { ledger: '#242b3a', cobalt: '#1a43bd' },
    'dark-3': { ledger: '#1b1f2a', cobalt: '#141c4f' },
    'dark-4': { ledger: '#171b24', cobalt: '#070b22' },
    'dark-5': { ledger: '#14171f', cobalt: '#0a0f2c' },
    'hairline-dark': { ledger: '#2a3040', cobalt: 'rgb(255 255 255 / 0.08)' },
    'border-dark': { ledger: '#3a4256', cobalt: 'rgb(255 255 255 / 0.14)' },
    'disabled-dark': { ledger: '#4a5470', cobalt: '#5a6699' },
    'text-dark': { ledger: '#e6eaf2', cobalt: '#e8ecff' },
    'text-secondary-dark': { ledger: '#9aa6bd', cobalt: '#a7b3ea' },
    'text-caption-dark': { ledger: '#8792ab', cobalt: '#8b98d6' },
    'accent-dark': { ledger: '#f08287', cobalt: '#ff8f97' },
    'accent-wash-dark': { ledger: '#3a2b34', cobalt: 'rgb(255 77 90 / 0.16)' }
  }

  it.each(Object.entries(rampTokens))(
    '--color-%s has a distinct Cobalt-dark value under body.body--cobalt.body--dark',
    (name, { ledger, cobalt }) => {
      expect(declaredValue(darkSource, `color-${name}`), `--color-${name} Cobalt dark value`).toBe(
        cobalt
      )
      expect(cobalt).not.toBe(ledger)
    }
  )

  it('leaves --color-dark-1 and --color-dark-6 inherited (no Cobalt-dark value specified)', () => {
    expect(darkSource).not.toMatch(/--color-dark-1:/)
    expect(darkSource).not.toMatch(/--color-dark-6:/)
  })
})

describe('Plain Cobalt aesthetic tokens, restated for dark', () => {
  const plainTokens = {
    paper: { cobaltLight: '#f2f5ff', cobaltDark: '#0a0f2c' },
    tint: { cobaltLight: '#e6edff', cobaltDark: '#070b22' },
    'tint-alt': { cobaltLight: '#e6edff', cobaltDark: '#141c4f' },
    hairline: { cobaltLight: '#dfe5f5', cobaltDark: 'rgb(255 255 255 / 0.08)' },
    'text-body': { cobaltLight: '#1a2038', cobaltDark: '#e8ecff' },
    'text-secondary': { cobaltLight: '#4a5580', cobaltDark: '#a7b3ea' },
    'text-caption': { cobaltLight: '#5a6699', cobaltDark: '#8b98d6' },
    'accent-wash': { cobaltLight: '#ffe9eb', cobaltDark: 'rgb(255 77 90 / 0.16)' },
    'accent-strong': { cobaltLight: '#1f4fd6', cobaltDark: '#7fa0ff' },
    'heading-h2': { cobaltLight: '#1f4fd6', cobaltDark: '#8fb0ff' },
    'inner-rule': { cobaltLight: '#e6edff', cobaltDark: 'rgb(255 255 255 / 0.06)' },
    'sidebar-hairline': {
      cobaltLight: 'rgb(255 255 255 / 0.08)',
      cobaltDark: 'rgb(255 255 255 / 0.06)'
    },
    'tag-chip-bg': { cobaltLight: '#dbe5ff', cobaltDark: 'rgb(61 109 247 / 0.22)' },
    'tag-chip-text': { cobaltLight: '#1a3fb0', cobaltDark: '#a3bbff' },
    'tag-chip-accent-bg': { cobaltLight: '#ffe9eb', cobaltDark: 'rgb(255 77 90 / 0.16)' },
    'tag-chip-accent-text': { cobaltLight: '#c8303c', cobaltDark: '#ff8f97' },
    'avatar-plate-bg': { cobaltLight: '#dbe5ff', cobaltDark: 'rgb(61 109 247 / 0.22)' },
    'avatar-plate-text': { cobaltLight: '#1a3fb0', cobaltDark: '#a3bbff' }
  }

  it.each(Object.entries(plainTokens))(
    '--color-%s has a distinct Cobalt-dark value',
    (name, { cobaltLight, cobaltDark }) => {
      expect(declaredValue(darkSource, `color-${name}`), `--color-${name} Cobalt dark value`).toBe(
        cobaltDark
      )
      expect(cobaltDark).not.toBe(cobaltLight)
    }
  )

  it('leaves --color-accent-fill, --color-positive-fill, --color-footer-link/-text unchanged (not redeclared)', () => {
    expect(darkSource).not.toMatch(/--color-accent-fill:/)
    expect(darkSource).not.toMatch(/--color-positive-fill:/)
    expect(darkSource).not.toMatch(/--color-footer-link:/)
    expect(darkSource).not.toMatch(/--color-footer-text:/)
  })
})

describe('--shadow-card dark override', () => {
  it('carries the handoff-specified dark card shadow, distinct from the light Cobalt value', () => {
    expect(declaredValue(darkSource, 'shadow-card')).toBe('0 2px 12px rgb(0 0 0 / 0.4)')
  })
})

describe('no shape token is redeclared', () => {
  it('declares no --radius-*, --corner-marks or --page-header-* inside the dark block', () => {
    expect(darkSource).not.toMatch(/--radius-/)
    expect(darkSource).not.toMatch(/--corner-marks:/)
    expect(darkSource).not.toMatch(/--page-header-/)
  })
})

describe('admin-configurable brand colors are left alone', () => {
  it('declares no --q-* override inside body.body--cobalt.body--dark', () => {
    expect(darkSource).not.toMatch(/--q-[a-z]/)
  })
})

describe('Cobalt dark color pairs clear WCAG AA where the handoff specifies a surface', () => {
  const meetsAA = (fg, bg) => contrastRatio(fg, bg) >= WCAG_AA_CONTRAST

  it('body/secondary/caption text tiers clear AA on the Cobalt dark app ground (#0a0f2c)', () => {
    const ground = '#0a0f2c'
    expect(meetsAA('#e8ecff', ground)).toBe(true)
    expect(meetsAA('#a7b3ea', ground)).toBe(true)
    expect(meetsAA('#8b98d6', ground)).toBe(true)
  })

  it('body/secondary text tiers also clear AA on the card/raised surface (#141c4f)', () => {
    const raised = '#141c4f'
    expect(meetsAA('#e8ecff', raised)).toBe(true)
    expect(meetsAA('#a7b3ea', raised)).toBe(true)
  })

  it('h2/link accent tones clear AA on the Cobalt dark app ground and raised surface', () => {
    expect(meetsAA('#8fb0ff', '#0a0f2c')).toBe(true)
    expect(meetsAA('#7fa0ff', '#0a0f2c')).toBe(true)
    expect(meetsAA('#8fb0ff', '#141c4f')).toBe(true)
    expect(meetsAA('#7fa0ff', '#141c4f')).toBe(true)
  })

  it('the lightened accent text clears AA on the card/raised surface it is specified against (#141c4f)', () => {
    expect(meetsAA('#ff8f97', '#141c4f')).toBe(true)
  })

  it('tag chip and avatar plate text clear AA on their translucent fill composited over the app ground', () => {
    // --color-tag-chip-bg / --color-avatar-plate-bg are rgb(61 109 247 / 0.22) -- a translucent fill,
    // not a flat surface -- so composite it over the dark app ground (#0a0f2c) by hand before
    // checking the text against the resulting flat color, the same as a browser paints it.
    // rgb(61 109 247 / 0.22) over #0a0f2c ~= #152459.
    expect(meetsAA('#a3bbff', '#152459')).toBe(true)
  })
})
