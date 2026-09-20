import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * Cobalt's footer bar is fixed, and `--article-column-pad`'s bottom padding sits INSIDE the
 * scrollport: it clears the article's own content but not where the scrollport -- and its native
 * scrollbar -- ends. Only a margin on the stretched wrapper does that, hence the geometry assertions
 * here, in a real browser neither DOM emulator's absent layout engine could answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

const FOOTER_CLEARANCE_MARGIN = 32.5

async function readSfcStyles(relativePath) {
  const source = await readFile(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line, since a top-level SFC `<style>` tag is never indented: a
  //    bare `<style[^>]*>` would also match a docstring merely MENTIONING the tag, swallowing
  //    everything up to the real closing tag into one unparseable blob.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

async function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return await readSfcStyles(relativePath)
}

/*
 * `.page-container`'s row as `Index.vue` renders it: the `.min-w-0.flex-1` wrapper -- the stretched
 * flex item, with no explicit height of its own -- around the scrolling article column. The filler
 * is tall enough to force real overflow.
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
      //    `body.body--cobalt`, and a custom property inherits DOWN the tree, so `<html>` would only
      //    ever see the bare `:root` default.
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
      // -> `.page-container-scrl` is a `height: 100%` child, unaffected by margins of its own, so
      //    shrinking the wrapper's border box stops the scrollport above the fixed footer bar too
      //    rather than running it behind.
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
 * Cobalt's `--article-column-pad` bottom value and the margin above have to keep summing to 60px:
 * changing either one alone silently shifts where fully-scrolled content sits.
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
    // -> `top right bottom left` shorthand: the third value is the bottom pad.
    expect(parts[2]).toBe('27.5px')
    expect(Number.parseFloat(parts[2]) + FOOTER_CLEARANCE_MARGIN).toBe(60)
  })
})
