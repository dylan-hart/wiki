import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as sass from 'sass'

/*
  The editor screen's chrome, against `ui-redesign/Cardinal Wiki - Editor 3x.dc.html` (OpenProject
  #2624).

  Everything under test here is a ground, a hairline or a measurement -- which is exactly what
  neither `jsdom` nor `happy-dom` can answer for, since neither runs a layout engine or a real
  cascade, and mounting a Monaco editor in a real Chromium to read four background colours off it is
  out of all proportion to the claim. So the stylesheet itself is the artifact under test: each SFC's
  own `<style lang="scss">` block is compiled through the same Sass, with the same `_theme`/`_palette`
  injection `vite.config.js` and `vitest.config.js` both apply, and the emitted declarations are read
  back. That catches the things a class-name assertion cannot -- a token resolving to the wrong hex,
  a theme-scoped rule quietly out-specifying an unscoped override -- without pretending to have
  measured a layout.

  One suite across three components rather than three near-identical copies, following
  `editorMarkupShared.test.js`: what they share is the design file, not an implementation.
*/

const componentsDir = dirname(fileURLToPath(import.meta.url))
const srcDir = dirname(componentsDir)

/**
 * One SFC's `<style lang="scss">` block, compiled the way the app compiles it.
 *
 * The `@use` prelude mirrors `css.preprocessorOptions.scss.additionalData` exactly; without it a bare
 * `$primary` / `$tint` in a component's rules is an undefined-variable error rather than a value.
 *
 * @param {string} fileName an SFC in this directory
 * @returns {string} the compiled CSS
 */
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

/**
 * The declarations one selector carries, as a `property: value` map. Sass has already flattened its
 * nesting by this point, but it does NOT strip comments — and a `/* … *\/` left in front of a
 * declaration would otherwise be swallowed into that declaration's property name, so it is dropped
 * here before the split. Reading the map rather than substring-matching the whole sheet is what makes
 * a wrong value fail as a wrong value instead of as a missing one.
 *
 * @param {string} css
 * @param {string} selector the exact, whole selector as Sass emits it
 * @returns {Record<string, string>}
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
    The single largest disagreement this comparison turned up: the rail and the markup bar were a dark
    slate block and a cardinal-red band, with a darker red stub bridging them across the top. Cardinal
    is continuous light slate chrome with hairline borders, and the accent is reserved for the live
    edge -- a permanent red bar over the surface an author spends the most time on is neither.
  */
  it('draws the insert rail as light slate chrome, ruled off from the source pane', () => {
    expect(declarations(css, '.editor-markdown-sidebar')).toMatchObject({
      width: '48px',
      padding: '8px 0'
    })
    expect(declarations(css, '.body--light .editor-markdown-sidebar')).toEqual({
      'background-color': '#eef1f7',
      'border-inline-end': '1px solid #dbe1ec',
      color: '#38465f'
    })
    // -> The red band that used to bridge the rail into the toolbar above it
    expect(css).not.toContain('border-top: 32px')
  })

  it('draws the markup bar as the same chrome, at the design’s 40px', () => {
    expect(declarations(css, '.editor-markdown-toolbar')).toMatchObject({
      height: '40px',
      padding: '0 8px'
    })
    expect(declarations(css, '.body--light .editor-markdown-toolbar')).toEqual({
      'background-color': '#eef1f7',
      'border-bottom': '1px solid #dbe1ec',
      color: '#38465f'
    })
  })

  /*
    Both toolbars are 40px, and each pane below one subtracts that height to fill what is left. They
    are driven off a single Sass variable precisely so this can be asserted as one claim: a band moved
    without its pane is how Monaco ends up overflowing its column.
  */
  it('leaves each pane exactly the height its toolbar does not take', () => {
    expect(declarations(css, '.editor-markdown-editor').height).toBe('calc(100% - 40px)')
    expect(declarations(css, '.editor-markdown-preview-content').height).toBe('calc(100% - 40px)')
    expect(declarations(css, '.editor-markdown-preview-toolbar').height).toBe('40px')
  })

  it('renders the preview onto paper, with the design’s article inset', () => {
    expect(declarations(css, '.body--light .editor-markdown-preview')['background-color']).toBe(
      '#fff'
    )
    expect(declarations(css, '.body--light .editor-markdown-preview-toolbar')).toMatchObject({
      'background-color': '#fff',
      'border-bottom': '1px solid #dbe1ec'
    })
    expect(declarations(css, '.editor-markdown-preview-content').padding).toBe('22px 24px')
  })

  /*
    The seam between the two panes is a `#dbe1ec` strip in the design. The 9px hit strip over it and
    its accent highlight are deliberately kept: a mock cannot draw "while you are dragging this", and
    the highlight only ever appears then.
  */
  it('rules the pane seam with a hairline, keeping the accent for the drag itself', () => {
    expect(declarations(css, '.editor-markdown-mid')['border-inline-end']).toBe('5px solid #dbe1ec')
    expect(declarations(css, '.editor-markdown-divider::after')['background-color']).toBe('#c14a52')
  })

  /*
    The group rule between the inline-markup buttons and the block-level ones. Its colour has to go
    through `--w-hairline-color`, since `WSeparator` renders `.w-hairline`, which is transparent and
    paints its line on an `::after` reading that property.
  */
  it('rules the markup bar’s two groups apart at the design’s 20px', () => {
    expect(declarations(css, '.editor-markdown-toolbar-rule')).toMatchObject({
      height: '20px',
      margin: '0 5px',
      '--w-hairline-color': '#dbe1ec'
    })
  })

  it('sets the rail’s label down it as a mono overline rather than as faint white text', () => {
    expect(declarations(css, '.editor-markdown-type')).toMatchObject({
      'writing-mode': 'vertical-rl',
      'font-family': 'var(--font-mono)',
      'font-size': '9.5px',
      'letter-spacing': '0.22em',
      'text-transform': 'uppercase',
      color: '#57668a'
    })
  })
})

describe('the page actions rail while a page is being written', () => {
  const css = compileStyles('PageActionsCol.vue')

  /*
    Every button on this rail already switched to `color="white"` while the editor was open, but the
    rail itself stayed on the light tint with a 2px accent edge -- so an author was looking at white
    glyphs on `#eef1f7`. Filling it is both what the design draws and what makes those glyphs legible;
    the two halves of that were out of step, and this is the assertion that keeps them together.
  */
  it('fills the rail, in the tone a white glyph and a white overline can ride on', () => {
    const filled = declarations(css, '.body--light .page-actions.is-editor')
    // -> `$primary`, not the design's `#e4676b`: see `docs/cardinal-reskin-second-pass.md`'s
    //    "One deliberate divergence" -- a fill carrying white text takes the darker tone.
    expect(filled['background-color']).toBe('#c14a52')
    expect(filled.color).toBe('#fff')
    expect(declarations(css, '.body--dark .page-actions.is-editor')['background-color']).toBe(
      '#c14a52'
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
      Through the custom property, not `background-color`: `.w-hairline` is transparent and paints its
      line on an `::after` that reads `--w-hairline-color`, so a colour set on the element itself is a
      rule that looks correct in the source and draws nothing on the screen.
    */
    expect(declarations(css, '.page-actions.is-editor .w-separator')).toEqual({
      '--w-hairline-color': 'rgb(255 255 255 / 0.3)'
    })
  })

  /*
    The filled rules are written under both `.body--light` and `.body--dark` rather than bare, because
    the rail's resting ground is itself theme-scoped: a bare `.page-actions.is-editor` would be one
    class short of `.body--light .page-actions` and lose the cascade to it outright.
  */
  it('scopes the fill to both themes, so it out-specifies the rail’s resting ground', () => {
    expect(declarations(css, '.page-actions.is-editor')).not.toHaveProperty('background-color')
  })
})

describe('the collaborator faces in the page header', () => {
  const css = compileStyles('CollabPresence.vue')

  it('rings each face in the header’s own paper rather than a near-white grey', () => {
    expect(declarations(css, '.body--light .collab-presence-bubble')['box-shadow']).toBe(
      '0 0 0 2px #fff'
    )
  })
})
