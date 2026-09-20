import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import WFooter from '@/components/shared/WFooter.vue'
import FooterNav from '@/components/FooterNav.vue'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Real browser, not `jsdom`/`happy-dom`: a `position: fixed` claim (stays put while an ancestor
 * scrolls, spans the full window width even past a reserved scrollbar gutter) is genuine layout, and
 * neither DOM emulator runs a layout engine -- `getBoundingClientRect()` comes back zeroed
 * regardless of the CSS under either.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return sfcStyles(relativePath)
}

/**
 * Wrapped in the `.page-container-scrl` ancestor the Cobalt rule scopes to: `Index.vue`'s `<style>`
 * is unscoped, so an unqualified `.w-footer` selector would also reach `FileManager.vue`'s and
 * `Search.vue`'s own footers. The tall filler stands in for a long article, so the bar's pinning is
 * proved by geometry rather than by the computed `position` value alone.
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
      // -> Below the tall filler, where the scrolling column's last child belongs.
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
      // -> Above `WDrawer.vue`'s overlay drawer and its scrim, so a drawer never covers the bar.
      expect(cobalt.zIndex).toBe('45')
      // -> Pinned by `insetInline` rather than `width: 100vw`, so a reserved scrollbar gutter does
      //    not push it past the viewport's right edge.
      expect(cobalt.rect.left).toBe(0)
      expect(cobalt.rect.width).toBeCloseTo(viewport.width, 0)
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
