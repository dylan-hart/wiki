import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import WFooter from '@/components/shared/WFooter.vue'
import FooterNav from '@/components/FooterNav.vue'
import WBtn from '@/components/shared/WBtn.vue'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The Cobalt footer bar across a RANGE of viewport widths, and against both overlay drawers open
 * TOGETHER -- the per-file suites each cover one file in isolation at a hand-picked width.
 *
 * The two drawers deliberately differ: the TOC drawer stops clear of the bar, while the nav drawer
 * reaches the true bottom of the screen and overlaps it, drawn on top by a higher z-index.
 *
 * Real browser: every assertion here is `position: fixed` box geometry neither DOM emulator's
 * non-existent layout engine can answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line: `WDrawer.vue`'s `side` prop doc contains the substring
  //    "<style>", which a bare `<style[^>]*>` would match, swallowing the file into one blob.
  return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return sfcStyles(relativePath)
}

function footerHtml() {
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
  return wrapper.html()
}

function tocOpenBtnHtml() {
  const { wrapper } = mountWithApp(WBtn, {
    props: {
      icon: 'tabler:binary-tree',
      color: 'primary',
      round: true,
      size: 'md'
    },
    attrs: {
      class: 'corner-btn corner-btn--right',
      'aria-label': 'Table of contents',
      'aria-expanded': 'false'
    }
  })
  return `<div class="toc-open-btn-anchor fixed bottom-0 right-0 z-30">${wrapper.html()}</div>`
}

async function measure({ browser, css, html, bodyClasses, viewport }, evaluator) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">` +
        `<div style="height:${viewport.height}px; overflow:hidden">${html}</div>` +
        '</body></html>'
    )
    return await page.evaluate(evaluator)
  } finally {
    await page.close()
  }
}

describe(
  'full-bleed footer — cross-viewport stacking verification',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css

    beforeAll(async () => {
      browser = await chromium.launch()
      css = [
        await buildAppCss(),
        compileSfcStyles(join('src', 'layouts', 'MainLayout.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WLayout.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WDrawer.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WHeader.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WPageContainer.vue')),
        compileSfcStyles(join('src', 'pages', 'Index.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WFooter.vue')),
        compileSfcStyles(join('src', 'components', 'FooterNav.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WBtn.vue'))
      ].join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    /*
      Spans both sides of the 749.98px overlay breakpoint, so one sweep covers the wide-column AND
      the overlay-drawer regime.
    */
    const widths = [1440, 1024, 900, 700, 480, 360]

    describe.each(widths)('at %dpx wide', (width) => {
      const viewport = { width, height: 700 }

      it('is a full-window-width fixed bar in Cobalt', async () => {
        const html =
          '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
          '<div class="page-container-body" style="height: 2000px">tall article filler</div>' +
          footerHtml() +
          '</div>'
        const result = await measure(
          { browser, css, html, bodyClasses: 'body--light body--cobalt', viewport },
          () => {
            const rect = document.querySelector('.w-footer').getBoundingClientRect()
            return {
              position: getComputedStyle(document.querySelector('.w-footer')).position,
              rect
            }
          }
        )

        expect(result.position).toBe('fixed')
        expect(result.rect.left).toBe(0)
        expect(result.rect.width).toBeCloseTo(viewport.width, 0)
      })

      it("does not stretch Ledger's footer to the full window (Cobalt-only change)", async () => {
        // -> The sibling column is what makes the assertion meaningful: a lone flex child fills its
        //    parent regardless of aesthetic, so it would pass even with Ledger's footer full-bleed.
        const html =
          '<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height: 100%">' +
          '<div style="flex: 0 0 300px"></div>' +
          '<div class="min-w-0 flex-1" style="height: 100%">' +
          '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
          '<div class="page-container-body" style="height: 100px">short article filler</div>' +
          footerHtml() +
          '</div>' +
          '</div>' +
          '</div>'
        const result = await measure(
          { browser, css, html, bodyClasses: 'body--light', viewport },
          () => {
            const el = document.querySelector('.w-footer')
            return {
              position: getComputedStyle(el).position,
              width: el.getBoundingClientRect().width
            }
          }
        )

        expect(result.position).toBe('static')
        // -> Sized by its own content column, so it must fall short of the viewport by roughly the
        //    fixture's 300px sidebar stand-in.
        expect(result.width).toBeLessThan(viewport.width - 250)
      })
    })

    /*
      Only meaningful below the 749.98px breakpoint, where both drawers are `position: fixed`
      overlays instead of grid/flex columns.
    */
    describe.each([700, 480, 360])(
      'overlay drawers + footer together, at %dpx wide (narrow)',
      (width) => {
        const viewport = { width, height: 700 }

        function shellHtml() {
          return (
            '<div class="w-layout w-layout--page">' +
            '<header class="w-header"></header>' +
            '<aside class="w-drawer bg-sidebar w-drawer--left flex flex-col w-drawer--overlay fixed inset-y-0 z-40 start-0" ' +
            'style="--w-drawer-width: 300px">' +
            '<div style="flex: 1 1 0; min-height: 0; overflow-y: auto">' +
            '<div style="height: 2000px">nav filler</div>' +
            '</div>' +
            '</aside>' +
            // -> `WLayout.vue`'s `:deep(> .w-page-container)` rule reproduced inline: raw extracted
            //    `<style>` text never runs an SFC's `:deep()` transform, so that rule cannot apply.
            '<div class="w-page-container" style="min-height: 0; overflow: auto">' +
            '<div class="page-container flex min-h-0 flex-nowrap items-stretch" style="height: 100%">' +
            '<div class="min-w-0 flex-1" style="height: 100%">' +
            '<div class="page-container-scrl" style="height: 100%; overflow-y: auto">' +
            '<div class="page-container-body" style="height: 2000px">article filler</div>' +
            footerHtml() +
            '</div>' +
            '</div>' +
            '<div class="page-sidebar is-open" style="order: 2">' +
            '<div style="height: 2000px">toc filler</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            tocOpenBtnHtml()
          )
        }

        it('the TOC drawer does not overlap the fixed footer bar, and the nav drawer reaches the true bottom of the screen ABOVE it, in Cobalt', async () => {
          const result = await measure(
            {
              browser,
              css,
              html: shellHtml(),
              bodyClasses: 'body--light body--cobalt',
              viewport
            },
            () => {
              const footer = document.querySelector('.w-footer')
              const nav = document.querySelector('.bg-sidebar')
              const footerRect = footer.getBoundingClientRect()
              const navRect = nav.getBoundingClientRect()
              return {
                footerTop: footerRect.top,
                navBottom: navRect.bottom,
                tocBottom: document.querySelector('.page-sidebar').getBoundingClientRect().bottom,
                navZIndex: Number(getComputedStyle(nav).zIndex),
                footerZIndex: Number(getComputedStyle(footer).zIndex),
                // -> Which of the two actually paints on top at a point both cover: the near
                //    bottom-left corner, inside the drawer's width and the bar's height.
                navIsAboveFooterAtCorner: Boolean(
                  document.elementFromPoint(10, window.innerHeight - 10)?.closest('.bg-sidebar')
                )
              }
            }
          )

          expect(result.tocBottom).toBeLessThanOrEqual(result.footerTop + 0.5)
          expect(result.navBottom).toBeCloseTo(viewport.height, 0)
          expect(result.navZIndex).toBeGreaterThan(result.footerZIndex)
          expect(result.navIsAboveFooterAtCorner).toBe(true)
        })

        it('the TOC-open corner button is not hidden behind the fixed footer bar, in Cobalt', async () => {
          const result = await measure(
            {
              browser,
              css,
              html: shellHtml(),
              bodyClasses: 'body--light body--cobalt',
              viewport
            },
            () => {
              const footerTop = document.querySelector('.w-footer').getBoundingClientRect().top
              const btnRect = document.querySelector('.toc-open-btn-anchor').getBoundingClientRect()
              return { footerTop, btnRect }
            }
          )

          expect(result.btnRect.bottom).toBeLessThanOrEqual(result.footerTop + 0.5)
          // -> Guards against clearing the bar by collapsing the button instead.
          expect(result.btnRect.height).toBeGreaterThan(0)
        })

        it('is unaffected in Ledger (no fixed footer to clear)', async () => {
          const result = await measure(
            {
              browser,
              css,
              html: shellHtml(),
              bodyClasses: 'body--light',
              viewport
            },
            () => {
              const btnRect = document.querySelector('.toc-open-btn-anchor').getBoundingClientRect()
              return { bottom: btnRect.bottom, viewportHeight: window.innerHeight }
            }
          )

          // -> `--footer-bar-height` is 0 in Ledger, so nothing lifts the button off `bottom-0`.
          expect(result.bottom).toBeCloseTo(result.viewportHeight, 0)
        })
      }
    )
  }
)
