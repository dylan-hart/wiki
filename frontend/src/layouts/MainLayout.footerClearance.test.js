import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'

/**
 * OpenProject #3018: the left nav drawer (`.bg-sidebar`, `MainLayout.vue`) has to clear Cobalt's
 * fixed footer bar (`Index.vue`'s `.page-container-scrl .w-footer` rule, OpenProject #3017/#3010) --
 * its own content and internal scrollbar should stop above the bar rather than extending underneath
 * or behind it, on both a wide (own grid column, stretched by `WLayout.vue`'s grid) and a narrow
 * (`WDrawer.vue`'s `position: fixed` overlay) viewport.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as `Index.footerCobalt.test.js`: this
 * is genuine box geometry (a stretched grid item's used height minus its margin, a `position: fixed`
 * panel's `bottom` offset) that neither DOM emulator's non-existent layout engine can answer --
 * `getBoundingClientRect()` comes back zeroed regardless of the CSS under either.
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
 * The shell exactly as `MainLayout.vue`/`WLayout.vue`/`WDrawer.vue` render it, reduced to what this
 * test needs: a real `.w-layout` grid (so `.bg-sidebar` gets the same stretch-to-grid-area sizing it
 * gets in the app), a `.bg-sidebar` with a tall filler standing in for a long nav list, and the same
 * `.page-container-scrl > .w-footer` structure `Index.footerCobalt.test.js` already proved becomes
 * the fixed Cobalt bar. `isOverlay` switches in the classes `WDrawer.vue` itself would apply below
 * its breakpoint -- there is no Vue reactivity in this static fixture to derive them from a viewport
 * width, so the two modes are built explicitly instead, matching what each real width renders.
 */
function mainLayoutHtml({ isOverlay }) {
  const overlayClasses = isOverlay ? 'w-drawer--overlay fixed inset-y-0 z-40 start-0' : ''
  return (
    '<div class="w-layout w-layout--page">' +
    '<header class="w-header"></header>' +
    `<aside class="w-drawer bg-sidebar w-drawer--left flex flex-col ${overlayClasses}" ` +
    'style="--w-drawer-width: 300px">' +
    // -> `NavSidebar.vue`'s own `.sidebar-nav` wrapper (`flex: 1 1 0; min-height: 0;
    //    overflow-y: auto`), reproduced here rather than a bare filler div: without it a tall
    //    filler's own content height contributes directly to `.bg-sidebar`'s min-content size,
    //    which grows the grid's `auto` footer-row track to accommodate it instead of letting the
    //    shell's `height: 100vh; overflow: hidden` actually bound the drawer -- exactly the
    //    `min-height: 0` escape hatch the real component's own comment documents.
    '<div style="flex: 1 1 0; min-height: 0; overflow-y: auto">' +
    '<div style="height: 2000px">nav filler</div>' +
    '</div>' +
    '</aside>' +
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

async function measureShell({ browser, css, isOverlay, bodyClasses, viewport }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">${mainLayoutHtml({ isOverlay })}</body></html>`
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
      return {
        sidebarBottom: sidebar.getBoundingClientRect().bottom,
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
        bodyClasses: 'body--light',
        viewport: wideViewport
      })

      expect(ledger.footerPosition).toBe('static')
      expect(ledger.footerBarHeight).toBe(0)
      // -> Stretches the full grid area, all the way to the shell's own bottom edge.
      expect(ledger.sidebarBottom).toBeCloseTo(wideViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a wide viewport', async () => {
      const cobalt = await measureShell({
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
      // -> No overlap: the drawer's own bottom edge sits at or above the bar's top edge.
      expect(cobalt.sidebarBottom).toBeLessThanOrEqual(cobalt.footerTop + 0.5)
    })

    it('is unaffected in Ledger, on a narrow (overlay) viewport', async () => {
      const ledger = await measureShell({
        browser,
        css,
        isOverlay: true,
        bodyClasses: 'body--light',
        viewport: narrowViewport
      })

      expect(ledger.footerBarHeight).toBe(0)
      expect(ledger.sidebarBottom).toBeCloseTo(narrowViewport.height, 0)
    })

    it('stops above the fixed footer bar in Cobalt, on a narrow (overlay) viewport', async () => {
      const cobalt = await measureShell({
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
