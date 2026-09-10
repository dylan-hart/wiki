import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3032: the left nav drawer (`.bg-sidebar`, `MainLayout.vue`) must ALWAYS reach the
 * true bottom of the screen, in every aesthetic and colour mode -- Dylan's own direct instruction,
 * reverting #3018's opposite approach (shrinking the drawer to clear Cobalt's fixed footer bar,
 * `Index.vue`'s `.page-container-scrl .w-footer` rule, OpenProject #3017/#3010). The bar now insets
 * from the sidebar's own edge instead, on a wide viewport (its own grid column); on a narrow one
 * (`WDrawer.vue`'s `position: fixed` overlay) the two occupy the same full-height space, and the
 * open overlay sits visually ABOVE the bar via a higher `z-index` rather than stopping short of it.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as `Index.footerCobalt.test.js`: this
 * is genuine box geometry (a stretched grid item's used height, a `position: fixed` panel's own
 * offsets, and which of two overlapping fixed elements actually paints on top) that neither DOM
 * emulator's non-existent layout engine can answer -- `getBoundingClientRect()` comes back zeroed
 * regardless of the CSS under either, and there is no paint order to query at all.
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

const SIDEBAR_WIDTH = 300

/**
 * The shell exactly as `MainLayout.vue`/`WLayout.vue`/`WDrawer.vue` render it, reduced to what this
 * test needs: a real `.w-layout` grid (so `.bg-sidebar` gets the same stretch-to-grid-area sizing it
 * gets in the app), a `.bg-sidebar` with a tall filler standing in for a long nav list, and the same
 * `.page-container-scrl > .w-footer` structure `Index.footerCobalt.test.js` already proved becomes
 * the fixed Cobalt bar. `isOverlay` switches in the classes `WDrawer.vue` itself would apply below
 * its breakpoint -- there is no Vue reactivity in this static fixture to derive them from a viewport
 * width, so the two modes are built explicitly instead, matching what each real width renders.
 *
 * `sidebarCurrentWidth` is set as an inline custom property on the `.w-layout` root, exactly the way
 * `MainLayout.vue`'s own `<script setup>` mirrors its reactive `sidebarCurrentWidth` onto
 * `--sidebar-current-width` via `:style` -- there is no Vue here to compute it live, so the test
 * states the value that computation would have produced for the scenario under test.
 * `includeSidebar: false` reproduces a page/site with no sidebar at all (`isSidebarOpen` false,
 * `WDrawer.vue`'s `v-show` collapsing the column to zero width) -- the fixture then renders no
 * `.bg-sidebar` element, matching what `MainLayout.vue`'s template actually omits from paint.
 */
function mainLayoutHtml({ isOverlay, includeSidebar = true, sidebarCurrentWidth = '0px' }) {
  const overlayClasses = isOverlay ? 'w-drawer--overlay fixed inset-y-0 z-40 start-0' : ''
  const sidebar = includeSidebar
    ? `<aside class="w-drawer bg-sidebar w-drawer--left flex flex-col ${overlayClasses}" ` +
      `style="--w-drawer-width: ${SIDEBAR_WIDTH}px">` +
      // -> `NavSidebar.vue`'s own `.sidebar-nav` wrapper (`flex: 1 1 0; min-height: 0;
      //    overflow-y: auto`), reproduced here rather than a bare filler div: without it a tall
      //    filler's own content height contributes directly to `.bg-sidebar`'s min-content size,
      //    which grows the grid's `auto` footer-row track to accommodate it instead of letting the
      //    shell's `height: 100vh; overflow: hidden` actually bound the drawer -- exactly the
      //    `min-height: 0` escape hatch the real component's own comment documents.
      '<div style="flex: 1 1 0; min-height: 0; overflow-y: auto">' +
      '<div style="height: 2000px">nav filler</div>' +
      '</div>' +
      '</aside>'
    : ''
  return (
    `<div class="w-layout w-layout--page" style="--sidebar-current-width: ${sidebarCurrentWidth}">` +
    '<header class="w-header"></header>' +
    sidebar +
    // -> `min-height: 0; overflow: auto` inline, standing in for `WLayout.vue`'s own
    //    `.w-layout :deep(> .w-page-container) { min-height: 0; overflow: auto }` rule: `:deep()` is
    //    a Vue SFC *compile-time* transform (into a scoped, hashed descendant selector) that a bare
    //    `sass.compileString` of the extracted `<style>` text never runs, so that rule reaches this
    //    fixture as literal, browser-invalid `:deep(...)` syntax and is dropped. Left unreplaced,
    //    `.w-page-container`'s own 2000px article filler (below) would keep its default
    //    content-based automatic minimum size, growing the grid's shared `1fr` row -- and therefore
    //    `.bg-sidebar`, which spans the same row -- to match, which is the real rule's whole job to
    //    prevent.
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
  sidebarCurrentWidth,
  bodyClasses,
  viewport
}) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">${mainLayoutHtml({ isOverlay, includeSidebar, sidebarCurrentWidth })}</body></html>`
    )
    return await page.evaluate(() => {
      const sidebar = document.querySelector('.bg-sidebar')
      const footer = document.querySelector('.w-footer')
      // -> `document.body`, not `document.documentElement`: the Cobalt override lives on
      //    `body.body--cobalt` (`tailwind.css`), and a custom property inherits DOWN the tree, not
      //    up -- reading it off `<html>` would only ever see the bare `:root` default (`0`).
      const footerBarHeight = Number.parseFloat(
        getComputedStyle(document.body).getPropertyValue('--footer-bar-height')
      )
      const footerRect = footer.getBoundingClientRect()
      const sidebarRect = sidebar?.getBoundingClientRect()
      // -> Which of the two actually paints on top at a point both a fixed sidebar overlay and the
      //    fixed footer bar cover -- the near bottom-left corner, just inside the sidebar's own
      //    width and the bar's own height. `closest` rather than an exact-element check: the point
      //    lands on whichever descendant box is there (the nav filler's own scroll container), not
      //    necessarily the `<aside>` itself.
      const topElementAtCorner = document.elementFromPoint(10, window.innerHeight - 10)
      return {
        sidebarTop: sidebarRect?.top ?? null,
        sidebarBottom: sidebarRect?.bottom ?? null,
        sidebarRight: sidebarRect?.right ?? null,
        footerTop: footerRect.top,
        footerLeft: footerRect.left,
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
      // -> Stretches the full grid area, all the way to the shell's own bottom edge.
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
      // -> No longer shrunk by the footer bar's height (OpenProject #3018's rule, reverted): the
      //    sidebar reaches the shell's own bottom edge exactly like Ledger's does above.
      expect(cobalt.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
      // -> The bar's own reading-START edge sits at the sidebar's reading-END edge instead --
      //    making room for it rather than painting over it.
      expect(cobalt.footerLeft).toBeCloseTo(SIDEBAR_WIDTH, 0)
      expect(cobalt.footerLeft).toBeCloseTo(cobalt.sidebarRight, 0)
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
      // -> Nothing to make room for: the bar's reading-START edge stays flush with the viewport's.
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
      // -> No longer pulled up by `bottom: var(--footer-bar-height)` (OpenProject #3018's rule,
      //    reverted): the open overlay reaches both true edges of the window, same as Ledger's.
      expect(cobalt.sidebarTop).toBeCloseTo(0, 0)
      expect(cobalt.sidebarBottom).toBeCloseTo(narrowViewport.height, 0)
      // -> Below the sidebar's own permanent-column breakpoint the bar stays full width rather than
      //    making room -- the two occupy the exact same bottom-left patch of the window, so it is
      //    the open overlay's higher z-index (46 vs. the bar's 45) that keeps it drawn on top,
      //    checked below, not a footer inset.
      expect(cobalt.footerLeft).toBeCloseTo(0, 0)
      expect(cobalt.sidebarIsAboveFooterAtCorner).toBe(true)
    })
  }
)
