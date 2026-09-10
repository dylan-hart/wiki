import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import WFooter from '@/components/shared/WFooter.vue'
import FooterNav from '@/components/FooterNav.vue'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #3017 (Feature #3010): the site footer (`Index.vue`'s `<w-footer><footer-nav /></w-footer>`,
 * the last child of `.page-container-scrl`) becomes a `position: fixed`, full-viewport-width bar pinned
 * to the bottom of the window under Cobalt, instead of the last item in the scrolling article column --
 * Ledger keeps the original stacked-in-flow behaviour unchanged.
 *
 * Real browser, not `jsdom`/`happy-dom`: this is a genuine `position: fixed` layout claim (stays put
 * while an ancestor scrolls, spans the full window width even past a reserved scrollbar gutter), and
 * neither DOM emulator runs a layout engine at all -- `getBoundingClientRect()` comes back zeroed
 * regardless of the CSS under either (see `test/realGridLayout.js`'s own docstring, and
 * `Index.pageHeaderCobalt.test.js`/`Index.breadcrumbCobalt.test.js` for the same reasoning applied to
 * paint-only assertions on this same file).
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
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
 * The footer exactly as `Index.vue` renders it, wrapped in the same `.page-container-scrl` ancestor
 * its own new stylesheet rule scopes to (see that rule's comment for why the ancestor is load-bearing:
 * this file's `<style>` is unscoped, so an unqualified `.w-footer` selector would also reach
 * `FileManager.vue`'s and `Search.vue`'s own unrelated footers). A tall filler div stands in for a long
 * article, so the real test below can prove the bar stays at the window's bottom edge rather than
 * merely trusting the computed `position` value.
 */
async function mountFooterHtml() {
  const { wrapper } = mountWithApp(WFooter, {
    slots: { default: '<footer-nav />' },
    components: { FooterNav },
    messages: {
      common: {
        footerCopyright: '© {year} {company}. All rights reserved.',
        footerLicense: 'Content is available under the {license}, by {company}.',
        footerGeneric: 'Powered by {link}, an open source project.',
        footerPoweredBy: 'Powered by {link}',
        license: { alr: 'All Rights Reserved' }
      }
    },
    stores: {
      site: {
        company: 'Acme Corp',
        contentLicense: 'alr',
        footerExtra: 'A second colophon line, for a realistic two-line bar.'
      }
    }
  })
  return (
    '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
    '<div class="page-container-body" style="height: 2000px">tall article filler</div>' +
    wrapper.html() +
    '</div>'
  )
}

/** Every computed value + geometry the assertions below need, for one aesthetic. */
async function measureFooter({ browser, css, html, bodyClasses, viewport }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">` +
        `<div style="height:${viewport.height}px; overflow:hidden">` +
        `<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height:100%">` +
        `<div class="min-w-0 flex-1" style="height:100%">${html}</div>` +
        '</div></div></body></html>'
    )
    return await page.evaluate(() => {
      const el = document.querySelector('.w-footer')
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return {
        position: style.position,
        insetInlineStart: style.insetInlineStart,
        insetInlineEnd: style.insetInlineEnd,
        bottom: style.bottom,
        zIndex: style.zIndex,
        rect: { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width }
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'site footer positioning — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css
    const viewport = { width: 900, height: 500 }

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

    it('stays in normal flow, stacked under the article, in Ledger', async () => {
      const html = await mountFooterHtml()
      const ledger = await measureFooter({
        browser,
        css,
        html,
        bodyClasses: 'body--light',
        viewport
      })

      expect(ledger.position).toBe('static')
      // -> Below the 2000px filler, exactly where the scrolling column's last child belongs -- not
      //    pinned to the 500px-tall viewport's own bottom edge.
      expect(ledger.rect.bottom).toBeGreaterThan(viewport.height)
    })

    it('becomes a fixed, full-viewport-width bar pinned to the window bottom, in Cobalt', async () => {
      const html = await mountFooterHtml()
      const cobalt = await measureFooter({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt',
        viewport
      })

      expect(cobalt.position).toBe('fixed')
      expect(cobalt.bottom).toBe('0px')
      expect(cobalt.insetInlineStart).toBe('0px')
      expect(cobalt.insetInlineEnd).toBe('0px')
      // -> Above the overlay nav drawer's z-40/scrim's z-30 (`WDrawer.vue`), so it stays the topmost
      //    thing on screen even with a drawer open.
      expect(cobalt.zIndex).toBe('45')
      // -> Spans the WHOLE viewport width, not merely the article column's -- pinned by `insetInline`
      //    rather than `width: 100vw`, so it is unaffected by the scrollbar this fixture's tall filler
      //    content forces into existence.
      expect(cobalt.rect.left).toBe(0)
      expect(cobalt.rect.width).toBeCloseTo(viewport.width, 0)
      // -> Flush with the window's own bottom edge, not the scrolling column's.
      expect(cobalt.rect.bottom).toBeCloseTo(viewport.height, 0)
    })

    it('stays pinned to the window, not the scrolling column, once the article is scrolled', async () => {
      const html = await mountFooterHtml()
      const page = await browser.newPage({ viewport })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
            '<body class="body--light body--cobalt" style="margin:0">' +
            `<div style="height:${viewport.height}px; overflow:hidden">` +
            `<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height:100%">` +
            `<div class="min-w-0 flex-1" style="height:100%">${html}</div>` +
            '</div></div></body></html>'
        )
        const before = await page.evaluate(
          () => document.querySelector('.w-footer').getBoundingClientRect().bottom
        )
        await page.evaluate(() => {
          document.querySelector('.page-container-scrl').scrollTop = 400
        })
        const after = await page.evaluate(
          () => document.querySelector('.w-footer').getBoundingClientRect().bottom
        )

        expect(after).toBeCloseTo(before, 0)
        expect(after).toBeCloseTo(viewport.height, 0)
      } finally {
        await page.close()
      }
    })
  }
)
