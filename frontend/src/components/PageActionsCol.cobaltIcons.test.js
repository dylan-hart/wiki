import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { tokenValue } from '../../test/tokens.js'

/*
  OpenProject #2903: the Cobalt reading rail's icon colours, against
  `ui-iteration/cobalt/Cardinal Wiki - Page View 3x - Cobalt.dc.html` -- Page Properties (the plate)
  draws white, every other button draws the saturated accent blue.

  Neither `jsdom` nor `happy-dom` installs the Cobalt half of the token layer (`test/setup.js` only
  installs Ledger's, see `test/tokens.js`), so a mount-based assertion would read Ledger's values
  regardless of the `body--cobalt` class on the fixture -- this instead compiles the SFC's own
  `<style lang="scss">` block the same way the app does (mirroring `editorScreenChrome.test.js`) and
  reads the resolved rule text back, which is what actually exposes a selector that never matches.
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

    // -> The regression itself: the plate no longer carries its own `color`, which is what let
    //    `w-btn`'s inline `color: var(--color-accent-fill)` (red, on the equally-red plate) win.
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
    //    so this selector never matched anything as a live rule -- pinned here so it can't quietly
    //    come back. `[,{]` rather than a bare match: the fix's own explanatory comment names the
    //    dead selector in prose, which the compiled CSS keeps verbatim (Sass does not strip
    //    comments), and that mention is not itself a rule.
    expect(css).not.toMatch(/\.aspect-square:not\(:first-child\)\s*[,{]/)
  })
})
