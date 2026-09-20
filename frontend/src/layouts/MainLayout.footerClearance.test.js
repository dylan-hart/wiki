import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * Real Chromium, not `jsdom`/`happy-dom`: this is genuine box geometry -- a stretched grid item's
 * used height, a `position: fixed` panel's own offsets, and which of two overlapping fixed elements
 * actually paints on top -- that neither DOM emulator's non-existent layout engine can answer.
 * `getBoundingClientRect()` comes back zeroed regardless of the CSS, and there is no paint order to
 * query at all.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line (a top-level SFC `<style>` tag is never indented): a bare
  //    `<style[^>]*>` also matches a docstring merely MENTIONING "<style>", swallowing everything
  //    up to the real closing tag into one unparseable blob.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain, already-valid CSS, native nesting
  //    included, which the real Chromium below parses natively.
  return sfcStyles(relativePath)
}

const SIDEBAR_WIDTH = 300

/**
 * The shell as `MainLayout.vue`/`WLayout.vue`/`WDrawer.vue` render it, reduced to what this test
 * needs. There is no Vue reactivity in a static fixture to derive anything from, so each knob
 * states the value the real computation would have produced: `isOverlay` the classes `WDrawer.vue`
 * applies below its breakpoint, `sidebarCurrentWidth`/`sidebarPosition` the inline custom
 * properties `MainLayout.vue` mirrors onto the `.w-layout` root, and `includeSidebar: false` a site
 * whose drawer column is collapsed to zero width and painted not at all.
 */
function mainLayoutHtml({
  isOverlay,
  includeSidebar = true,
  sidebarPosition = 'left',
  sidebarCurrentWidth = '0px'
}) {
  const onEndSide = sidebarPosition === 'right'
  const insetInlineStart = onEndSide ? '0px' : sidebarCurrentWidth
  const insetInlineEnd = onEndSide ? sidebarCurrentWidth : '0px'
  const overlayClasses = isOverlay
    ? `w-drawer--overlay fixed inset-y-0 z-40 ${onEndSide ? 'end-0' : 'start-0'}`
    : ''
  const sidebar = includeSidebar
    ? `<aside class="w-drawer bg-sidebar ${onEndSide ? 'w-drawer--right' : 'w-drawer--left'} flex flex-col ${overlayClasses}" ` +
      `style="--w-drawer-width: ${SIDEBAR_WIDTH}px">` +
      // -> `NavSidebar.vue`'s own `.sidebar-nav` wrapper rather than a bare filler div: without its
      //    `min-height: 0`, the filler's content height feeds `.bg-sidebar`'s min-content size and
      //    grows the grid's `auto` footer-row track instead of letting the shell's
      //    `height: 100vh; overflow: hidden` bound the drawer.
      '<div style="flex: 1 1 0; min-height: 0; overflow-y: auto">' +
      '<div style="height: 2000px">nav filler</div>' +
      '</div>' +
      '</aside>'
    : ''
  return (
    `<div class="w-layout w-layout--page" style="--sidebar-current-width: ${sidebarCurrentWidth}; ` +
    `--sidebar-inset-inline-start: ${insetInlineStart}; --sidebar-inset-inline-end: ${insetInlineEnd}">` +
    '<header class="w-header"></header>' +
    sidebar +
    // -> Inline, standing in for `WLayout.vue`'s `.w-layout :deep(> .w-page-container)` rule:
    //    `:deep()` is a compile-time SFC transform, so raw extracted `<style>` text carries it to
    //    the browser as invalid syntax and it is dropped. Unreplaced, the article filler below
    //    keeps its content-based minimum size and grows the shared `1fr` row -- and with it
    //    `.bg-sidebar`, which spans the same row.
    '<div class="w-page-container" style="min-height: 0; overflow: auto">' +
    '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
    '<div class="page-container-body" style="height: 2000px">article filler</div>' +
    '<div class="w-footer"><div>footer content</div></div>' +
    '</div>' +
    '</div>' +
    '</div>'
  )
}

async function measureShell({
  browser,
  css,
  isOverlay,
  includeSidebar,
  sidebarPosition,
  sidebarCurrentWidth,
  bodyClasses,
  viewport
}) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">${mainLayoutHtml({ isOverlay, includeSidebar, sidebarPosition, sidebarCurrentWidth })}</body></html>`
    )
    return await page.evaluate(() => {
      const sidebar = document.querySelector('.bg-sidebar')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt`, and a custom property inherits DOWN the tree -- reading it off
      //    `<html>` would only ever see the bare `:root` default.
      const footerBarHeight = Number.parseFloat(
        getComputedStyle(document.body).getPropertyValue('--footer-bar-height')
      )
      const footerRect = footer.getBoundingClientRect()
      const sidebarRect = sidebar?.getBoundingClientRect()
      // -> Which of the two paints on top where the fixed sidebar overlay and the fixed footer bar
      //    both cover -- the near bottom-left corner. `closest` rather than an exact-element check:
      //    the point lands on whichever descendant box is there, not necessarily the `<aside>`.
      const topElementAtCorner = document.elementFromPoint(10, window.innerHeight - 10)
      return {
        sidebarTop: sidebarRect?.top ?? null,
        sidebarBottom: sidebarRect?.bottom ?? null,
        sidebarLeft: sidebarRect?.left ?? null,
        sidebarRight: sidebarRect?.right ?? null,
        footerTop: footerRect.top,
        footerLeft: footerRect.left,
        footerRight: footerRect.right,
        footerPosition: getComputedStyle(footer).position,
        footerBarHeight,
        sidebarIsAboveFooterAtCorner: Boolean(topElementAtCorner?.closest('.bg-sidebar'))
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'nav drawer footer clearance — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css
    const wideViewport = { width: 1400, height: 700 }
    // -> Below `WDrawer.vue`'s `overlayBelow` (`SIDEBAR_OVERLAY_BELOW`, `MainLayout.vue`): the
    //    drawer becomes a `position: fixed` overlay instead of a grid column.
    const narrowViewport = { width: 900, height: 700 }

    beforeAll(async () => {
      browser = await chromium.launch()
      css = [
        await buildAppCss(),
        compileSfcStyles(join('src', 'layouts', 'MainLayout.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WLayout.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WDrawer.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WHeader.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WPageContainer.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WFooter.vue')),
        compileSfcStyles(join('src', 'pages', 'Index.vue'))
      ].join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('is unaffected in Ledger, on a wide viewport (own grid column)', async () => {
      const ledger = await measureShell({
        browser,
        css,
        isOverlay: false,
        sidebarCurrentWidth: `${SIDEBAR_WIDTH}px`,
        bodyClasses: 'body--light',
        viewport: wideViewport
      })

      expect(ledger.footerPosition).toBe('static')
      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('reaches the true bottom of the screen in Cobalt on a wide viewport, and the footer bar insets to meet it', async () => {
      const cobalt = await measureShell({
        browser,
        css,
        isOverlay: false,
        sidebarCurrentWidth: `${SIDEBAR_WIDTH}px`,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
      // -> The bar makes room for the sidebar rather than painting over it.
      expect(cobalt.footerLeft).toBeCloseTo(SIDEBAR_WIDTH, 0)
      expect(cobalt.footerLeft).toBeCloseTo(cobalt.sidebarRight, 0)
    })

    it('reaches the true bottom of the screen in Cobalt on a wide viewport with a RIGHT-positioned sidebar, insetting the opposite edge (OpenProject #3142)', async () => {
      const cobalt = await measureShell({
        browser,
        css,
        isOverlay: false,
        sidebarPosition: 'right',
        sidebarCurrentWidth: `${SIDEBAR_WIDTH}px`,
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
      // -> The mirror image of the default left-positioned case above: the bar insets its
      //    reading-END edge and stays flush with the viewport at the start.
      expect(cobalt.footerRight).toBeCloseTo(wideViewport.width - SIDEBAR_WIDTH, 0)
      expect(cobalt.footerRight).toBeCloseTo(cobalt.sidebarLeft, 0)
      expect(cobalt.footerLeft).toBeCloseTo(0, 0)
    })

    it('keeps the Cobalt footer bar full width on a wide viewport when no sidebar column is occupied', async () => {
      const cobalt = await measureShell({
        browser,
        css,
        isOverlay: false,
        includeSidebar: false,
        sidebarCurrentWidth: '0px',
        bodyClasses: 'body--light body--cobalt',
        viewport: wideViewport
      })

      expect(cobalt.footerPosition).toBe('fixed')
      expect(cobalt.footerLeft).toBeCloseTo(0, 0)
    })

    it('is unaffected in Ledger, on a narrow (overlay) viewport', async () => {
      const ledger = await measureShell({
        browser,
        css,
        isOverlay: true,
        sidebarCurrentWidth: `${SIDEBAR_WIDTH}px`,
        bodyClasses: 'body--light',
        viewport: narrowViewport
      })

      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.sidebarTop).toBeCloseTo(0, 0)
      expect(ledger.sidebarBottom).toBeCloseTo(narrowViewport.height, 0)
    })

    it('reaches the true top and bottom of the screen in Cobalt on a narrow (overlay) viewport, above the footer bar', async () => {
      const cobalt = await measureShell({
        browser,
        css,
        isOverlay: true,
        sidebarCurrentWidth: `${SIDEBAR_WIDTH}px`,
        bodyClasses: 'body--light body--cobalt',
        viewport: narrowViewport
      })

      expect(cobalt.footerBarHeight).toBeGreaterThan(0)
      expect(cobalt.sidebarTop).toBeCloseTo(0, 0)
      expect(cobalt.sidebarBottom).toBeCloseTo(narrowViewport.height, 0)
      // -> Below the breakpoint the two occupy the same bottom corner, so the bar stays full width
      //    and it is the overlay's higher z-index, not a footer inset, that keeps it drawn on top.
      expect(cobalt.footerLeft).toBeCloseTo(0, 0)
      expect(cobalt.sidebarIsAboveFooterAtCorner).toBe(true)
    })
  }
)
