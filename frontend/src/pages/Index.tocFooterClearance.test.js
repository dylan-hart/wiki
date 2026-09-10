import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3018: the right TOC drawer (`.page-sidebar`, `Index.vue`) has to clear Cobalt's fixed
 * footer bar (`.page-container-scrl .w-footer`, OpenProject #3017/#3010) the same way
 * `MainLayout.footerClearance.test.js` proves `.bg-sidebar` does -- its own content and internal
 * scrollbar should stop above the bar rather than extending underneath or behind it, on both a wide
 * (flex row, stretched by `.page-container`'s `items-stretch`) and a narrow (`.page-sidebar`'s own
 * `position: fixed` overlay, below `$toc-overlay-max`) viewport.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as `Index.footerCobalt.test.js`: this
 * is genuine box geometry neither DOM emulator's non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line (Vue SFC convention: a top-level `<style>`/`</style>` tag is
  //    never indented) rather than a bare `<style[^>]*>`, which a docstring merely MENTIONING
  //    "<style>" -- `WDrawer.vue`'s own `side` prop comment does exactly this -- would also match,
  //    swallowing everything up to the real closing tag into one unparseable blob.
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
 * article column (carrying `.page-container-scrl > .w-footer`, the same structure
 * `Index.footerCobalt.test.js` already proves becomes the fixed Cobalt bar) beside `.page-sidebar`
 * with a tall filler standing in for a long contents list. `isOverlay` mirrors the class this
 * component itself only ever applies via its `@media (max-width: $toc-overlay-max)` rule -- there is
 * no viewport-driven CSS class toggle to reproduce here, so `is-open` is simply always present in the
 * narrow fixture, matching a reader who has opened the panel.
 */
function pageRowHtml({ isOverlay }) {
  return (
    '<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height: 100%">' +
    '<div class="min-w-0 flex-1" style="height: 100%">' +
    '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
    '<div class="page-container-body" style="height: 2000px">article filler</div>' +
    '<div class="w-footer"><div>footer content</div></div>' +
    '</div>' +
    '</div>' +
    `<div class="page-sidebar${isOverlay ? ' is-open' : ''}" style="order: 2">` +
    '<div style="height: 2000px">toc filler</div>' +
    '</div>' +
    '</div>'
  )
}

async function measureRow({ browser, css, isOverlay, bodyClasses, viewport }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">` +
        `<div style="height:${viewport.height}px; overflow:hidden">${pageRowHtml({ isOverlay })}</div>` +
        '</body></html>'
    )
    return await page.evaluate(() => {
      const sidebar = document.querySelector('.page-sidebar')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt` (`tailwind.css`), and a custom property inherits DOWN the tree, not
      //    up -- reading it off `<html>` would only ever see the bare `:root` default (`0`).
      const footerBarHeight = Number.parseFloat(
        getComputedStyle(document.body).getPropertyValue('--footer-bar-height')
      )
      return {
        sidebarBottom: sidebar.getBoundingClientRect().bottom,
        sidebarPosition: getComputedStyle(sidebar).position,
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
  'TOC drawer footer clearance — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css
    const wideViewport = { width: 1400, height: 700 }
    // -> Below Index.vue's own `$toc-overlay-max` (749.98px): `.page-sidebar` becomes a
    //    `position: fixed` overlay instead of a flex-row column.
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

    it('is unaffected in Ledger, on a wide viewport (flex row column)', async () => {
      const ledger = await measureRow({
        browser,
        css,
        isOverlay: false,
        bodyClasses: 'body--light',
        viewport: wideViewport
      })

      expect(ledger.footerPosition).toBe('static')
      expect(ledger.sidebarPosition).toBe('static')
      expect(ledger.footerBarHeight).toBe(0)
      // -> Stretches the full row height, all the way to the row's own bottom edge.
      expect(ledger.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a wide viewport', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        isOverlay: false,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      // -> Shrunk by exactly the footer bar's own height, not merely padded internally.
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height - cobalt.footerBarHeight, 0)
      // -> No overlap: the column's own bottom edge sits at or above the bar's top edge.
      expect(cobalt.sidebarBottom).toBeLessThanOrEqual(cobalt.footerTop + 0.5)
    })

    it('is unaffected in Ledger, on a narrow (overlay) viewport', async () => {
      const ledger = await measureRow({
        browser,
        css,
        isOverlay: true,
        bodyClasses: 'body--light',
        viewport: narrowViewport
      })

      expect(ledger.sidebarPosition).toBe('fixed')
      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.sidebarBottom).toBeCloseTo(narrowViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a narrow (overlay) viewport', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        isOverlay: true,
        bodyClasses: 'body--light body--cobalt',
        viewport: narrowViewport
      })

      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.sidebarBottom).toBeCloseTo(narrowViewport.height - cobalt.footerBarHeight, 0)
      expect(cobalt.sidebarBottom).toBeLessThanOrEqual(cobalt.footerTop + 0.5)
    })
  }
)
