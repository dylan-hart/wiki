import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * The right TOC drawer (`.page-sidebar`) has to clear Cobalt's fixed footer bar: its content and
 * internal scrollbar stop above the bar rather than running underneath it, both as a stretched flex
 * column on a wide viewport and as its own `position: fixed` overlay on a narrow one.
 *
 * Real browser: this is box geometry neither DOM emulator's non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line, since a top-level SFC `<style>` tag is never indented: a
  //    bare `<style[^>]*>` would also match a docstring merely MENTIONING the tag -- `WDrawer.vue`'s
  //    `side` prop comment does -- swallowing the rest of the file into one unparseable blob.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return sfcStyles(relativePath)
}

/**
 * `.page-container`'s row reduced to what this test needs, with tall fillers forcing real overflow.
 * `is-open` tracks the panel being opened, not the viewport, so the narrow fixture simply always
 * carries it -- a reader who has opened the panel.
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

async function measureRow({ browser, css, isOverlay, bodyClasses, bodyStyle = '', viewport }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0;${bodyStyle}">` +
        `<div style="height:${viewport.height}px; overflow:hidden">${pageRowHtml({ isOverlay })}</div>` +
        '</body></html>'
    )
    return await page.evaluate(() => {
      const sidebar = document.querySelector('.page-sidebar')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt`, and a custom property inherits DOWN the tree, so `<html>` would only
      //    ever see the bare `:root` default.
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
    // -> Below the 749.98px breakpoint, where `.page-sidebar` becomes a `position: fixed` overlay
    //    instead of a flex-row column.
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
      // -> The column's own box is shorter, not merely padded internally.
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height - cobalt.footerBarHeight, 0)
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

    it('follows a live footer height written inline on body over the stylesheet fallback, in Cobalt', async () => {
      const cobalt = await measureRow({
        browser,
        css,
        isOverlay: false,
        bodyClasses: 'body--light body--cobalt',
        bodyStyle: '--footer-bar-height: 140px',
        viewport: wideViewport
      })

      expect(cobalt.footerBarHeight).toBe(140)
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height - 140, 0)
    })
  }
)
