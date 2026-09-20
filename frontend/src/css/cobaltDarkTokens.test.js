import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * There is no compiled stylesheet or layout engine here, so these assertions read `tailwind.css`'s
 * SOURCE TEXT directly. Contrast over these tokens belongs to `cobaltContrast.test.js`, the one
 * place that measures it.
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
    'dark-3-5': { ledger: '#171b24', cobalt: '#0e1540' },
    'dark-3-5-text': { ledger: '#8ea6cf', cobalt: '#c9d6ff' },
    'dark-4': { ledger: '#171b24', cobalt: '#070b22' },
    'dark-5': { ledger: '#14171f', cobalt: '#0a0f2c' },
    'hairline-dark': { ledger: '#2a3040', cobalt: '#2e3d9e' },
    'border-dark': { ledger: '#3a4256', cobalt: '#3b4fce' },
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
    hairline: { cobaltLight: '#dfe5f5', cobaltDark: '#2e3d9e' },
    'text-body': { cobaltLight: '#1a2038', cobaltDark: '#e8ecff' },
    'text-secondary': { cobaltLight: '#4a5580', cobaltDark: '#a7b3ea' },
    'text-caption': { cobaltLight: '#5a6699', cobaltDark: '#8b98d6' },
    'accent-wash': { cobaltLight: '#ffe9eb', cobaltDark: 'rgb(255 77 90 / 0.16)' },
    'accent-strong': { cobaltLight: '#1f4fd6', cobaltDark: '#7fa0ff' },
    'heading-h2': { cobaltLight: '#1f4fd6', cobaltDark: '#8fb0ff' },
    'inner-rule': { cobaltLight: '#e6edff', cobaltDark: 'rgb(255 255 255 / 0.06)' },
    'sidebar-hairline': {
      cobaltLight: 'rgb(255 255 255 / 0.08)',
      cobaltDark: '#2a3684'
    },
    'admin-sidebar-hairline': { cobaltLight: '#27337a', cobaltDark: '#2a3684' },
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
  it('carries a blue-tinted dark hairline-ring colour, distinct from the light Cobalt value (OpenProject #2933)', () => {
    expect(declaredValue(darkSource, 'shadow-card')).toBe('0 0 0 1px var(--color-hairline-dark)')
  })
})

describe('no overlay/menu shadow token is redeclared', () => {
  it('leaves --shadow-primary/-menu/-dialog and --page-header-shadow unrestated (all `none` under the light block already)', () => {
    expect(darkSource).not.toMatch(/--shadow-primary:/)
    expect(darkSource).not.toMatch(/--shadow-menu:/)
    expect(darkSource).not.toMatch(/--shadow-dialog:/)
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

/**
 * The generic `body.body--dark .w-input-control` rule points `--w-input-ring-error` at the
 * lightened `--color-accent-dark`; Cobalt dark wants light mode's brighter value, so it re-points at
 * `--color-accent-fill` -- which the Cobalt-dark token block deliberately does not restate. The rule
 * sits outside that token block, so it is sliced from the full source rather than `darkSource`.
 */
describe('Cobalt-dark .w-input-control error-ring override', () => {
  it('re-points --w-input-ring-error at --color-accent-fill under body.body--cobalt.body--dark', () => {
    const ruleStart = source.indexOf('body.body--cobalt.body--dark .w-input-control {')
    expect(ruleStart, 'body.body--cobalt.body--dark .w-input-control rule').toBeGreaterThan(-1)

    const ruleEnd = source.indexOf('\n  }', ruleStart)
    const ruleSource = source.slice(ruleStart, ruleEnd)

    expect(declaredValue(ruleSource, 'w-input-ring-error')).toBe('var(--color-accent-fill)')
  })

  it('leaves the generic body.body--dark .w-input-control rule pointed at --color-accent-dark', () => {
    const genericStart = source.indexOf('body.body--dark .w-input-control {')
    const genericEnd = source.indexOf('\n  }', genericStart)
    const genericSource = source.slice(genericStart, genericEnd)

    expect(declaredValue(genericSource, 'w-input-ring-error')).toBe('var(--color-accent-dark)')
  })
})
