import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3135: `Index.pageScrollFooterClearance.test.js` (OpenProject #3055) used to assert
 * that `body.body--cobalt .page-container > .min-w-0.flex-1` carried a
 * `margin-bottom: calc(var(--footer-bar-height) + 16px)` rule, shrinking the article column's own
 * stretched box so its scrollbar stopped above Cobalt's fixed footer bar. OpenProject #3089 deleted
 * that rule outright, reasoning it was redundant with `--article-column-pad`'s own Cobalt bottom
 * bump -- but that padding lives INSIDE the scrollport and only clears the article's own content, not
 * where the scrollport (and its native scrollbar) itself ends, so the scrollbar went back to running
 * behind the fixed bar. #3135 restores the margin rule, as a literal `32.5px` rather than the old
 * `calc(var(--footer-bar-height) + 16px)` formula, and cuts `--article-column-pad`'s Cobalt bottom
 * value by the same 32.5px so the two changes net to zero -- this suite asserts the wrapper now
 * carries exactly `32.5px` of margin-bottom in Cobalt (still none in Ledger), and that the wrapper's
 * own bottom edge sits that same 32.5px above the row's bottom edge.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as the suite this replaces: this is
 * genuine box geometry neither DOM emulator's non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

// -> This WP's own literal margin-bottom value (`Index.vue`) -- kept as one constant so a future
//    change to the number only has to happen once.
const FOOTER_CLEARANCE_MARGIN = 32.5

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
  'article column wrapper carries the Cobalt footer-clearance margin — real layout',
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

    it('carries a 32.5px margin-bottom in Cobalt, on a wide viewport (OpenProject #3135)', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.wrapperMarginBottom).toBe(`${FOOTER_CLEARANCE_MARGIN}px`)
      // -> Shrunk by exactly the margin, so both the wrapper's own border box and the scrollport it
      //    hands `.page-container-scrl` (a `height: 100%` child, unaffected by margins of its own)
      //    stop that same distance above the row's bottom edge -- flush above the fixed footer bar
      //    rather than running behind it.
      expect(cobalt.wrapperBottom).toBeCloseTo(wideViewport.height - FOOTER_CLEARANCE_MARGIN, 0)
      expect(cobalt.scrlBottom).toBeCloseTo(wideViewport.height - FOOTER_CLEARANCE_MARGIN, 0)
    })

    it('carries the same 32.5px margin-bottom in Cobalt, on a narrow viewport (OpenProject #3135)', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: narrowViewport
      })

      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.wrapperMarginBottom).toBe(`${FOOTER_CLEARANCE_MARGIN}px`)
      expect(cobalt.wrapperBottom).toBeCloseTo(narrowViewport.height - FOOTER_CLEARANCE_MARGIN, 0)
    })
  }
)

/*
 * `--article-column-pad`'s bottom value plus the margin above net to the same total trailing space
 * below the article this WP started from (OpenProject #3055/#3089's `60px`) -- a regression in
 * either number alone would silently shift the page's fully-scrolled content position, which this
 * WP's own acceptance criterion says must stay exactly where it is today.
 */
describe('Cobalt cuts its article-column-pad bottom value to match the new margin (OpenProject #3135)', () => {
  it('declares 27.5px of bottom padding, not the pre-#3135 60px', async () => {
    const css = await readFile(join(frontendRoot, 'src', 'css', 'tailwind.css'), 'utf8')
    const cobaltHalf = css.slice(css.indexOf('body.body--cobalt {'))

    const match = /--article-column-pad:\s*([^;]+);/.exec(cobaltHalf)
    expect(
      match,
      'tailwind.css should still declare --article-column-pad under body--cobalt'
    ).not.toBeNull()

    const parts = match[1].trim().split(/\s+/)
    // -> `top right bottom left` shorthand -- the third value is the bottom pad this WP relies on.
    expect(parts[2]).toBe('27.5px')
    // -> 27.5 + 32.5 (the margin above) == 60, the pre-#3135 total -- the fully-scrolled content
    //    position this net-zero swap is meant to leave unchanged.
    expect(Number.parseFloat(parts[2]) + FOOTER_CLEARANCE_MARGIN).toBe(60)
  })
})
