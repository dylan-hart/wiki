import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * There is no compiled stylesheet or layout engine here to resolve a real `var()` cascade against,
 * so these assertions read `tailwind.css`'s SOURCE TEXT directly. What a consumer actually resolves
 * to is `infoboxTokensRealBrowser.test.js`'s job.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

const sectionStart = source.indexOf('-- The 8 block boards')
const ledgerDarkStart = source.indexOf('body.body--dark {', sectionStart)
const cobaltLightStart = source.indexOf('body.body--cobalt {', sectionStart)
const cobaltDarkStart = source.indexOf('body.body--cobalt.body--dark {', sectionStart)
const cobaltDarkEnd = source.indexOf('\n}', cobaltDarkStart)

const ledgerLightSource = source.slice(sectionStart, ledgerDarkStart)
const ledgerDarkSource = source.slice(ledgerDarkStart, cobaltLightStart)
const cobaltLightSource = source.slice(cobaltLightStart, cobaltDarkStart)
const cobaltDarkSource = source.slice(cobaltDarkStart, cobaltDarkEnd)

function declaredValue(slice, name) {
  const match = slice.match(new RegExp(`--${name}:\\s*([^;]*);`))
  return match ? match[1].trim() : undefined
}

describe('--infobox-border (OpenProject #2942)', () => {
  it('defaults to the shared --block-border alias in Ledger light', () => {
    expect(declaredValue(ledgerLightSource, 'infobox-border')).toBe('var(--block-border)')
  })

  it('is restated for Ledger dark, aliasing --block-border (OpenProject #2955)', () => {
    // -> Restated here, not left undeclared: a nested var(--block-border) assigned only at :root
    //    keeps resolving against <html>'s own Ledger-LIGHT value, drawing a near-white hairline on
    //    a dark card.
    expect(declaredValue(ledgerDarkSource, 'infobox-border')).toBe('var(--block-border)')
  })

  it('takes its own literal value in Cobalt light, distinct from the generic card border', () => {
    expect(declaredValue(cobaltLightSource, 'infobox-border')).toBe('#c9d6fb')
    // -> #dfe5f5 is what --block-border resolves to for a generic Cobalt-light page card.
    expect(declaredValue(cobaltLightSource, 'infobox-border')).not.toBe('#dfe5f5')
  })

  it('takes its own literal value in Cobalt dark, distinct from the generic ring', () => {
    expect(declaredValue(cobaltDarkSource, 'infobox-border')).toBe('rgb(143 176 255 / 0.28)')
    // -> #3143b9 is the generic --block-border Cobalt dark restates.
    expect(declaredValue(cobaltDarkSource, 'infobox-border')).not.toBe('#3143b9')
  })
})
