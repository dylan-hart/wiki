import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { tokenValue } from '../../test/tokens.js'

/*
  Neither `jsdom` nor `happy-dom` installs the Cobalt half of the token layer (`test/setup.js`
  installs Ledger's only, see `test/tokens.js`), so a mount-based assertion would read Ledger's
  values regardless of the `body--cobalt` class on the fixture. Reading the SFC's own `<style>`
  block back as text is also what exposes a selector that never matches anything.
*/

const componentsDir = dirname(fileURLToPath(import.meta.url))

function token(name, expected) {
  expect(tokenValue(name, 'cobalt'), `${name} should still be ${expected} under Cobalt`).toBe(
    expected
  )
  return `var(${name})`
}

function compileStyles(fileName) {
  const source = readFileSync(join(componentsDir, fileName), 'utf8')
  const block = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  expect(block, `${fileName} has a style block`).toBeTruthy()
  return block[1]
}

function declarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`(^|\\n|,\\s*)${escaped}\\s*(,[^{]*)?\\{([^}]*)\\}`))
  expect(rule, `${selector} is emitted`).toBeTruthy()
  return Object.fromEntries(
    rule[3]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      })
  )
}

describe('the Cobalt reading rail’s icon colours (OpenProject #2903)', () => {
  const css = compileStyles('PageActionsCol.vue')

  it('gives the Page Properties plate a white glyph, targeted at the icon rather than the plate', () => {
    const white = token('--color-white', '#fff')
    expect(
      declarations(
        css,
        'body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child .w-icon'
      )
    ).toEqual({ color: white })

    // -> A `color` on the plate itself would let `w-btn`'s inline `color: var(--color-accent-fill)`
    //    win -- red on an equally red plate.
    expect(
      declarations(
        css,
        'body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child'
      )
    ).not.toHaveProperty('color')
  })

  it('gives every other reading-rail button the saturated accent stroke, not the dead first-child-sibling selector', () => {
    const accentStrong = token('--color-accent-strong', '#1f4fd6')
    expect(
      declarations(css, 'body.body--cobalt .page-actions:not(.is-editor) > .h-12 .w-icon')
    ).toEqual({ color: accentStrong })

    // -> Page Properties is the rail's only `.aspect-square` cell (every other button is `.h-12`),
    //    so that selector can never match as a live rule. `[,{]` rather than a bare match: the
    //    style block is read as raw text, comments included, and the SFC names the dead selector in
    //    prose -- which is not itself a rule.
    expect(css).not.toMatch(/\.aspect-square:not\(:first-child\)\s*[,{]/)
  })
})
