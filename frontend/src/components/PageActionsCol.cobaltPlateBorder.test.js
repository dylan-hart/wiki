import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { tokenValue } from '../../test/tokens.js'

/*
  OpenProject #3040: the Cobalt reading rail's card "border" is a `box-shadow` ring
  (`--shadow-card`, painted OUTSIDE the box), not a real `border` -- and `.page-actions` carries an
  unconditional `overflow-y: auto` a few rules below this one, which per spec forces `overflow-x` to
  compute to `auto` too. That means a child can never cover an outer ring by overhanging the box (it
  gets clipped there, confirmed by screenshotting an isolated repro in real Chromium before landing
  this fix) -- the rail has to draw its own ring INSET instead, so the page-properties plate, flush
  with the box's own edges, covers it in ordinary z-order with no overflow or negative-margin tricks.

  Same reason as `PageActionsCol.cobaltIcons.test.js` for compiling the SFC's own `<style
  lang="scss">` block directly rather than mounting it: neither `jsdom` nor `happy-dom` installs the
  Cobalt half of the token layer, so a mount-based assertion would read Ledger's values regardless of
  the `body--cobalt` class on the fixture.
*/

const componentsDir = dirname(fileURLToPath(import.meta.url))
const srcDir = dirname(componentsDir)

function token(name, expected) {
  expect(tokenValue(name, 'cobalt'), `${name} should still be ${expected} under Cobalt`).toBe(
    expected
  )
  return `var(${name})`
}

function compileStyles(fileName) {
  const source = readFileSync(join(componentsDir, fileName), 'utf8')
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

describe('the Cobalt reading rail plate caps the card border, not just its width (OpenProject #3040)', () => {
  const css = compileStyles('PageActionsCol.vue')

  it("draws the rail's own ring inset rather than as an outer shadow, so a flush child can cover it", () => {
    const hairline = token('--color-hairline', '#dfe5f5')
    expect(declarations(css, 'body.body--cobalt .page-actions:not(.is-editor)')).toMatchObject({
      'box-shadow': `inset 0 0 0 1px ${hairline}`
    })

    // -> Never the shared, plain-outer-ring token every other floating Cobalt card still draws --
    //    flipping that token itself would change every other card's edge too.
    expect(declarations(css, 'body.body--cobalt .page-actions:not(.is-editor)')).not.toMatchObject({
      'box-shadow': 'var(--shadow-card)'
    })
  })

  it('sits flush with the card top/left/right edges and matches the card corner radius on top only', () => {
    const radiusCard = token('--radius-card', '8px')
    const radiusControl = token('--radius-control', '6px')
    expect(
      declarations(
        css,
        'body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child'
      )
    ).toMatchObject({
      margin: '0 auto 4px',
      'border-radius': `${radiusCard} ${radiusCard} ${radiusControl} ${radiusControl}`
    })
  })
})
