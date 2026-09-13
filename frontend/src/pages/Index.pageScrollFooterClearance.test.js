import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3055: the page's own scroll container (`.page-container-scrl`, `Index.vue`) gets no
 * bottom clearance from Cobalt's fixed footer bar (`.page-container-scrl .w-footer`, OpenProject
 * #3017/#3010), unlike `.page-sidebar` (the TOC), which already clears it the same way
 * (`Index.tocFooterClearance.test.js`) -- so the page's own scrollbar ran behind/under the bar
 * instead of stopping above it.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as `Index.footerCobalt.test.js` and
 * `Index.tocFooterClearance.test.js`: this is genuine box geometry neither DOM emulator's
 * non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line (Vue SFC convention: a top-level `<style>`/`</style>` tag is
  //    never indented) rather than a bare `<style[^>]*>`, which a docstring merely MENTIONING
  //    "<style>" would also match, swallowing everything up to the real closing tag into one
  //    unparseable blob -- see `Index.tocFooterClearance.test.js` for the same guard.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  const themeDir = join(frontendRoot, 'src', 'css')
  return sass.compileString(
    `@use '${join(themeDir, '_theme.scss')}' as *;\n` +
      `@use '${join(themeDir, '_palette.scss')}' as *;\n` +
      sfcStyles(relativePath),
    { loadPaths: [join(frontendRoot, 'src')] }
  ).css
}

/**
 * `.page-container`'s row exactly as `Index.vue` renders it, reduced to what this test needs: the
 * `.min-w-0.flex-1` wrapper -- the actual stretched flex item, with NO explicit height of its own,
 * matching the real template's line 59 -- around the scrolling article column
 * (`.page-container-scrl`, carrying a tall article filler and the site footer, the same structure
 * `Index.footerCobalt.test.js` already proves becomes the fixed Cobalt bar), beside an empty
 * `.page-sidebar` column.
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
      const scrl = document.querySelector('.page-container-scrl')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt` (`tailwind.css`), and a custom property inherits DOWN the tree, not
      //    up -- reading it off `<html>` would only ever see the bare `:root` default (`0`).
      const footerBarHeight = Number.parseFloat(
        getComputedStyle(document.body).getPropertyValue('--footer-bar-height')
      )
      return {
        scrlBottom: scrl.getBoundingClientRect().bottom,
        scrlMarginBottom: getComputedStyle(scrl).marginBottom,
        footerTop: footer.getBoundingClientRect().top,
        footerPosition: getComputedStyle(footer).position,
        footerBarHeight
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'page scroll container footer clearance — real layout',
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
        compileSfcStyles(join('src', 'pages', 'Index.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WFooter.vue')),
        compileSfcStyles(join('src', 'components', 'FooterNav.vue'))
      ].join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('is unaffected in Ledger, on a wide viewport', async () => {
      const ledger = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light',
        viewport: wideViewport
      })

      expect(ledger.footerPosition).toBe('static')
      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.scrlMarginBottom).toBe('0px')
      // -> Stretches the full row height, all the way to the row's own bottom edge.
      expect(ledger.scrlBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a wide viewport', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      // -> Shrunk by the footer bar's own height PLUS the extra 16px this WP adds -- not merely
      //    flush with the bar's top edge, and not left unclamped at all.
      expect(cobalt.scrlBottom).toBeCloseTo(wideViewport.height - cobalt.footerBarHeight - 16, 0)
      // -> No overlap: the column's own bottom edge (and hence its scrollbar) sits above the bar's
      //    top edge, with real daylight between the two -- not merely touching.
      expect(cobalt.scrlBottom).toBeLessThan(cobalt.footerTop - 1)
    })

    it('is unaffected in Ledger, on a narrow viewport', async () => {
      const ledger = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light',
        viewport: narrowViewport
      })

      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.scrlMarginBottom).toBe('0px')
      expect(ledger.scrlBottom).toBeCloseTo(narrowViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a narrow viewport', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        bodyClasses: 'body--light body--cobalt',
        viewport: narrowViewport
      })

      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.scrlBottom).toBeCloseTo(narrowViewport.height - cobalt.footerBarHeight - 16, 0)
      expect(cobalt.scrlBottom).toBeLessThan(cobalt.footerTop - 1)
    })
  }
)
