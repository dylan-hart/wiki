import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { tokenValue } from '../../test/tokens.js'

/*
  These rules name a TOKEN rather than the hex it resolves to -- an aesthetic is a second set of
  values for the same custom properties, so a rule baking one aesthetic's literal in could not follow
  it. Each assertion therefore checks both halves at once: that the rule names the right token, and
  that the token still carries the value the design draws, read out of `css/tailwind.css`.
*/
function token(name, expected) {
  expect(tokenValue(name), `${name} should still be ${expected} under Ledger`).toBe(expected)
  return `var(${name})`
}

/*
  Everything under test here is a ground, a hairline or a measurement -- which is exactly what
  neither `jsdom` nor `happy-dom` can answer for, since neither runs a layout engine or a real
  cascade, and mounting a Monaco editor in a real Chromium to read four background colours off it is
  out of all proportion to the claim. So the stylesheet itself is the artifact under test: each SFC's
  own `<style>` block is read back exactly as the app ships it. That catches what a class-name
  assertion cannot -- a token resolving to the wrong hex, a theme-scoped rule quietly out-specifying
  an unscoped override -- without pretending to have measured a layout.
*/

const componentsDir = dirname(fileURLToPath(import.meta.url))

/** Nothing is compiled, despite the name: an SFC's style block is already plain, valid CSS. */
function compileStyles(fileName) {
  const source = readFileSync(join(componentsDir, fileName), 'utf8')
  const block = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  expect(block, `${fileName} has a style block`).toBeTruthy()
  return block[1]
}

/**
 * A `/* … *\/` left in front of a declaration would be swallowed into that declaration's property
 * name, so comments are dropped before the split. Reading a map rather than substring-matching the
 * whole sheet is what makes a wrong value fail as a wrong value instead of as a missing one.
 *
 * @param {string} selector the exact, whole selector, as written in the style block
 */
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

describe('the markdown editor’s own chrome', () => {
  const css = compileStyles('EditorMarkdown.vue')

  /*
    The accent is reserved for the live edge, so the rail and the markup bar are continuous light
    slate chrome with hairline borders rather than a dark slate block and a cardinal-red band.
  */
  it('draws the insert rail as light slate chrome, ruled off from the source pane', () => {
    expect(declarations(css, '.editor-markdown-sidebar')).toMatchObject({
      width: '48px',
      padding: '8px 0'
    })
    expect(declarations(css, '.body--light .editor-markdown-sidebar')).toEqual({
      'background-color': token('--color-tint', '#eef1f7'),
      'border-inline-end': `1px solid ${token('--color-hairline', '#dbe1ec')}`,
      color: token('--color-slate', '#38465f')
    })
    // -> No red band bridging the rail into the toolbar above it.
    expect(css).not.toContain('border-top: 32px')
  })

  it('draws the markup bar as the same chrome, at the design’s 40px', () => {
    expect(declarations(css, '.editor-markdown-toolbar')).toMatchObject({
      height: '40px',
      padding: '0 8px'
    })
    expect(declarations(css, '.body--light .editor-markdown-toolbar')).toEqual({
      'background-color': token('--color-tint', '#eef1f7'),
      'border-bottom': `1px solid ${token('--color-hairline', '#dbe1ec')}`,
      color: token('--color-slate', '#38465f')
    })
  })

  /*
    Each pane subtracts its toolbar's 40px to fill what is left: a band whose height moves without
    its pane's is how Monaco ends up overflowing its column.
  */
  it('leaves each pane exactly the height its toolbar does not take', () => {
    expect(declarations(css, '.editor-markdown-editor').height).toBe('calc(100% - 40px)')
    expect(declarations(css, '.editor-markdown-preview-content').height).toBe('calc(100% - 40px)')
    expect(declarations(css, '.editor-markdown-preview-toolbar').height).toBe('40px')
  })

  it('renders the preview onto paper, with the design’s article inset', () => {
    expect(declarations(css, '.body--light .editor-markdown-preview')['background-color']).toBe(
      token('--color-surface', '#fff')
    )
    expect(declarations(css, '.body--light .editor-markdown-preview-toolbar')).toMatchObject({
      'background-color': token('--color-surface', '#fff'),
      'border-bottom': `1px solid ${token('--color-hairline', '#dbe1ec')}`
    })
    expect(declarations(css, '.editor-markdown-preview-content').padding).toBe('22px 24px')
  })

  /*
    The hit strip over the seam and its accent highlight are deliberately kept although the design
    shows neither: a static mock cannot draw "while you are dragging this", which is the only time
    the highlight appears.
  */
  it('rules the pane seam with a hairline, keeping the accent for the drag itself', () => {
    expect(declarations(css, '.editor-markdown-mid')['border-inline-end']).toBe(
      `5px solid ${token('--color-hairline', '#dbe1ec')}`
    )
    expect(declarations(css, '.editor-markdown-divider::after')['background-color']).toBe(
      token('--color-primary', '#c14a52')
    )
  })

  it('leaves squaring the markup bar’s buttons to the shared flush-hover class', () => {
    expect(css).not.toContain('.body--cobalt .editor-markdown-toolbar .w-btn')
  })

  it('lets the bars’ buttons stretch to the band, and the rail’s to the rail', () => {
    for (const selector of [
      '.editor-markdown-toolbar .w-btn',
      '.editor-markdown-preview-toolbar .w-btn'
    ]) {
      expect(declarations(css, selector), selector).toEqual({
        'align-self': 'stretch',
        'min-height': '0 !important'
      })
    }
    expect(declarations(css, '.editor-markdown-sidebar .w-btn')).toEqual({
      'align-self': 'stretch',
      'min-height': '34px !important',
      padding: '0 !important'
    })
  })

  /*
    The rule's colour goes through `--w-hairline-color`: `WSeparator` renders `.w-hairline`, which is
    transparent and paints its line on an `::after` reading that property.
  */
  it('rules the markup bar’s two groups apart at the design’s 20px', () => {
    expect(declarations(css, '.editor-markdown-toolbar-rule')).toMatchObject({
      height: '20px',
      margin: '0 5px',
      '--w-hairline-color': token('--color-hairline', '#dbe1ec')
    })
  })

  it('sets the rail’s label down it as a mono overline rather than as faint white text', () => {
    expect(declarations(css, '.editor-markdown-type')).toMatchObject({
      'writing-mode': 'vertical-rl',
      'font-family': 'var(--font-mono)',
      'font-size': '9.5px',
      'letter-spacing': '0.22em',
      'text-transform': 'uppercase',
      color: token('--color-text-caption', '#57668a')
    })
  })
})

describe('the page actions rail while a page is being written', () => {
  const css = compileStyles('PageActionsCol.vue')

  /*
    Every button on this rail is `color="white"` while the editor is open, so the rail itself has to
    be filled: white glyphs on the light tint are illegible. This keeps the two halves together.
  */
  it('fills the rail, in the tone a white glyph and a white overline can ride on', () => {
    const filled = declarations(css, '.body--light .page-actions.is-editor')
    /*
      `--color-accent`, not the design's `#e4676b`: a fill carrying white text takes the darker tone.
      Accent rather than `--color-primary` because the two are the same `#c14a52` in Ledger and part
      company under Cobalt, where an accent SURFACE is `#c8303c` and `primary` is that aesthetic's
      blue.
    */
    expect(filled['background-color']).toBe(token('--color-accent', '#c14a52'))
    expect(filled.color).toBe('#fff')
    expect(declarations(css, '.body--dark .page-actions.is-editor')['background-color']).toBe(
      token('--color-accent', '#c14a52')
    )
    expect(declarations(css, '.page-actions-mode').color).toBe('#fff')
  })

  it('marks the head of the filled rail with a wash, and its dividers in the same white', () => {
    for (const theme of ['light', 'dark']) {
      expect(
        declarations(css, `.body--${theme} .page-actions.is-editor > .aspect-square:first-child`)
      ).toEqual({
        'background-color': 'rgba(255, 255, 255, 0.14)',
        'border-block-end': '0'
      })
    }
    /*
      Through the custom property, not `background-color`: `.w-hairline` is transparent and paints
      its line on an `::after` that reads `--w-hairline-color`, so a colour set on the element itself
      looks correct in the source and draws nothing on the screen.
    */
    expect(declarations(css, '.page-actions.is-editor .w-separator')).toEqual({
      '--w-hairline-color': 'rgb(255 255 255 / 0.3)'
    })
  })

  /*
    The filled rules are scoped to both themes rather than written bare, because the rail's resting
    ground is itself theme-scoped: a bare `.page-actions.is-editor` is one class short of
    `.body--light .page-actions` and loses the cascade to it outright.
  */
  it('scopes the fill to both themes, so it out-specifies the rail’s resting ground', () => {
    expect(declarations(css, '.page-actions.is-editor')).not.toHaveProperty('background-color')
  })
})

describe('the collaborator faces in the page header', () => {
  const css = compileStyles('CollabPresence.vue')

  it('rings each face in the header’s own paper rather than a near-white grey', () => {
    expect(declarations(css, '.body--light .collab-presence-bubble')['box-shadow']).toBe(
      `0 0 0 2px ${token('--color-surface', '#fff')}`
    )
  })
})
