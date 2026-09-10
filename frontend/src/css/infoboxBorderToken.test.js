import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2942 ("Add infobox-specific Cobalt border tokens") -- Gap 1 of Feature #2937.
 *
 * Same rationale as `blockTokens.test.js`/`cobaltTokens.test.js`: asserting against `tailwind.css`'s
 * SOURCE TEXT directly, since there is no compiled stylesheet or layout engine in this test
 * environment to resolve a real `var()` cascade against. This suite covers only `--infobox-border`,
 * the one custom property this task owns inside the shared 4-state `--infobox-*` block ("-- The 8
 * block boards", OpenProject #2875) -- `.name` typography (#2943) and the image well (#2944) are
 * siblings under the same Feature and are not this file's concern.
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

/** Finds `--name: value;` in a slice. */
function declaredValue(slice, name) {
  const match = slice.match(new RegExp(`--${name}:\\s*([^;]*);`))
  return match ? match[1].trim() : undefined
}

describe('--infobox-border (OpenProject #2942)', () => {
  it('defaults to the shared --block-border alias in Ledger light', () => {
    expect(declaredValue(ledgerLightSource, 'infobox-border')).toBe('var(--block-border)')
  })

  it('is left undeclared for Ledger dark, inheriting --block-border’s own dark value unchanged', () => {
    expect(ledgerDarkSource).not.toMatch(/--infobox-border:/)
  })

  it('takes its own literal value in Cobalt light, distinct from the generic card border', () => {
    expect(declaredValue(cobaltLightSource, 'infobox-border')).toBe('#c9d6fb')
    // -> Not the generic page-card border Cobalt light draws for --block-border (var(--color-hairline)
    //    resolving to #dfe5f5) -- see blockTokens.test.js's own cross-check for that value.
    expect(declaredValue(cobaltLightSource, 'infobox-border')).not.toBe('#dfe5f5')
  })

  it('takes its own literal value in Cobalt dark, distinct from the generic ring', () => {
    expect(declaredValue(cobaltDarkSource, 'infobox-border')).toBe('rgb(143 176 255 / 0.28)')
    // -> Not the generic --block-border Cobalt dark restates (#3143b9, OpenProject #2912).
    expect(declaredValue(cobaltDarkSource, 'infobox-border')).not.toBe('#3143b9')
  })
})
