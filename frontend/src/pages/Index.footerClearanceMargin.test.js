import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3089: `Index.pageScrollFooterClearance.test.js` (OpenProject #3055) used to assert
 * that `body.body--cobalt .page-container > .min-w-0.flex-1` carried a
 * `margin-bottom: calc(var(--footer-bar-height) + 16px)` rule, shrinking the article column's own
 * stretched box so its scrollbar stopped above Cobalt's fixed footer bar. That rule turned out to be
 * redundant -- the same `--article-column-pad` bottom value (bumped from 44px to 60px by the same
 * #3055 commit) already gives the article body enough trailing whitespace to clear the bar in
 * practice, confirmed hands-on -- so #3089 deletes the margin rule outright and this suite replaces
 * that one, asserting the wrapper now behaves exactly like Ledger's (no margin at all) rather than
 * asserting on the deleted rule's old numbers.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as the suite this replaces: this is
 * genuine box geometry neither DOM emulator's non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

async function readSfcStyles(relativePath) {
  const source = await readFile(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line (Vue SFC convention: a top-level `<style>`/`</style>` tag is
  //    never indented) rather than a bare `<style[^>]*>`, which a docstring merely MENTIONING
  //    "<style>" would also match, swallowing everything up to the real closing tag into one
  //    unparseable blob -- see `Index.tocFooterClearance.test.js` for the same guard.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

async function compileSfcStyles(relativePath) {
  const themeDir = join(frontendRoot, 'src', 'css')
  const styles = await readSfcStyles(relativePath)
  return sass.compileString(
    `@use '${join(themeDir, '_theme.scss')}' as *;\n` +
      `@use '${join(themeDir, '_palette.scss')}' as *;\n` +
      styles,
    { loadPaths: [join(frontendRoot, 'src')] }
  ).css
}

/*
 * `.page-container`'s row exactly as `Index.vue` renders it, matching the structure
 * `Index.pageScrollFooterClearance.test.js` used to build: the `.min-w-0.flex-1` wrapper (the
 * actual stretched flex item, with no explicit height of its own, matching the real template's
 * line 59) around the scrolling article column, beside an empty `.page-sidebar` column. A tall
 * filler stands in for real article content, tall enough to force real overflow.
 */
function pageRowHtml() {
  return (
    '<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height: 100%">' +
    '<div class="min-w-0 flex-1">' +
    '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
    '<div class="page-container-body" style="height: 2000px">article filler</div>' +
    '<div class="w-footer"><div>footer content</div></div>' +
    '</div>' +
    '</div>' +
    '<div class="page-sidebar" style="order: 2"></div>' +
    '</div>'
  )
}

async function measureRow({ browser, css, bodyClasses, viewport }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">` +
        `<div style="height:${viewport.height}px; overflow:hidden">${pageRowHtml()}</div>` +
        '</body></html>'
    )
    return await page.evaluate(() => {
      const wrapper = document.querySelector('.min-w-0.flex-1')
      const scrl = document.querySelector('.page-container-scrl')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt` (`tailwind.css`), and a custom property inherits DOWN the tree, not
      //    up -- reading it off `<html>` would only ever see the bare `:root` default (`0`).
      const footerBarHeight = Number.parseFloat(
        getComputedStyle(document.body).getPropertyValue('--footer-bar-height')
      )
      return {
        wrapperMarginBottom: getComputedStyle(wrapper).marginBottom,
        wrapperBottom: wrapper.getBoundingClientRect().bottom,
        scrlBottom: scrl.getBoundingClientRect().bottom,
        footerPosition: getComputedStyle(footer).position,
        footerBarHeight
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'article column wrapper carries no footer-clearance margin — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css
    const wideViewport = { width: 1400, height: 700 }
    const narrowViewport = { width: 700, height: 700 }

    beforeAll(async () => {
      browser = await chromium.launch()
      css = [
        await buildAppCss(),
        await compileSfcStyles(join('src', 'pages', 'Index.vue')),
        await compileSfcStyles(join('src', 'components', 'shared', 'WFooter.vue')),
        await compileSfcStyles(join('src', 'components', 'FooterNav.vue'))
      ].join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('carries no margin-bottom in Ledger, on a wide viewport', async () => {
      const ledger = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light',
        viewport: wideViewport
      })

      expect(ledger.wrapperMarginBottom).toBe('0px')
      // -> Stretches the full row height, all the way to the row's own bottom edge.
      expect(ledger.wrapperBottom).toBeCloseTo(wideViewport.height, 0)
      expect(ledger.scrlBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('carries no margin-bottom in Cobalt either, on a wide viewport (OpenProject #3089)', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      // -> The whole point of #3089: no margin at all any more, in Cobalt exactly as in Ledger --
      //    the wrapper stretches to the row's full height rather than being shrunk to clear the bar.
      expect(cobalt.wrapperMarginBottom).toBe('0px')
      expect(cobalt.wrapperBottom).toBeCloseTo(wideViewport.height, 0)
      expect(cobalt.scrlBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('carries no margin-bottom in Cobalt, on a narrow viewport (OpenProject #3089)', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: narrowViewport
      })

      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.wrapperMarginBottom).toBe('0px')
      expect(cobalt.wrapperBottom).toBeCloseTo(narrowViewport.height, 0)
    })
  }
)

/*
 * `--article-column-pad`'s bottom value is the clearance the margin rule's removal now relies on
 * (OpenProject #3089's own scope explicitly keeps this at 60px rather than reverting it to 44px) --
 * a regression here would silently remove the wiki's ONLY remaining footer clearance in Cobalt.
 */
describe('Cobalt keeps its bumped article-column-pad bottom value (OpenProject #3055/#3089)', () => {
  it('still declares 60px of bottom padding, not the Ledger default of 44px', async () => {
    const css = await readFile(join(frontendRoot, 'src', 'css', 'tailwind.css'), 'utf8')
    const cobaltHalf = css.slice(css.indexOf('body.body--cobalt {'))

    const match = /--article-column-pad:\s*([^;]+);/.exec(cobaltHalf)
    expect(
      match,
      'tailwind.css should still declare --article-column-pad under body--cobalt'
    ).not.toBeNull()

    const parts = match[1].trim().split(/\s+/)
    // -> `top right bottom left` shorthand -- the third value is the bottom pad this WP relies on.
    expect(parts[2]).toBe('60px')
  })
})
