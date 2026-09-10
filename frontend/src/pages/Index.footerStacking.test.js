import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import WFooter from '@/components/shared/WFooter.vue'
import FooterNav from '@/components/FooterNav.vue'
import WBtn from '@/components/shared/WBtn.vue'

import { buildAppCss, chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #3019 (Feature #3010): cross-viewport/stacking verification of the finished full-bleed
 * Cobalt footer bar -- the one thing neither #3017's (`Index.footerCobalt.test.js`) nor #3018's
 * (`Index.tocFooterClearance.test.js`, `MainLayout.footerClearance.test.js`) own per-file suites
 * prove, since each tests its own file in isolation, at one or two hand-picked viewport widths.
 *
 * Three things this file adds:
 * 1. The footer stays a full-window-width bar across a RANGE of widths (desktop through narrow), not
 *    only the single 900px fixture `Index.footerCobalt.test.js` measured -- and Ledger's footer stays
 *    unaffected (not full-bleed at all) across that same range.
 * 2. Both overlay drawers (nav + TOC), open TOGETHER with the footer in one combined real fixture --
 *    not each drawer tested against the footer alone -- across several narrow widths. OpenProject
 *    #3032 (reverting #3018 for the nav drawer alone, per Dylan's own direct instruction) splits what
 *    "correct" means between them here: the TOC drawer still stops clear of the bar exactly as
 *    #3018 left it, while the nav drawer now deliberately reaches the true bottom of the screen and
 *    OVERLAPS the bar, drawn above it by a higher z-index instead.
 * 3. The TOC-open corner button (`pages/Index.vue`'s `fixed bottom-0 right-0 z-30` -- the sole
 *    remaining fixed corner button in the page view) does not end up hidden behind the opaque,
 *    higher-z-index footer bar. This is a genuine finding from writing this suite: before this Task's
 *    fix, the button sat entirely inside the footer bar's own painted region with a lower z-index, so
 *    the reader's only way to open the TOC panel on a narrow Cobalt screen disappeared behind it. See
 *    `.toc-open-btn-anchor`'s CSS comment in `Index.vue` for the fix.
 *
 * Real browser, not `jsdom`/`happy-dom`, for the same reason as the two suites above: every assertion
 * here is genuine `position: fixed` box geometry neither DOM emulator's non-existent layout engine can
 * answer.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  // -> Anchored to the START of a line, not a bare `<style[^>]*>` -- see the sibling suites' own
  //    comment (`WDrawer.vue`'s `side` prop doc literally contains the substring "<style>").
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

/** The footer exactly as `Index.vue` renders it -- see `Index.footerCobalt.test.js`'s own comment. */
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

/** The TOC-open corner button exactly as `Index.vue` renders it (template lines ~408-420). */
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
      Desktop through narrow/mobile, deliberately spanning both sides of `$toc-overlay-max`
      (749.98px) so the same sweep covers the wide-column AND overlay-drawer regimes.
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
        // -> A real sibling column (standing in for the nav/TOC sidebar) is what makes this
        //    assertion meaningful: with no sibling at all, a lone flex child fills 100% of its
        //    parent regardless of aesthetic, which would pass whether or not Ledger's footer were
        //    (wrongly) pinned full-bleed too.
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
        // -> Ledger's footer is a normal-flow block, sized by its own content column (this fixture's
        //    300px sidebar stand-in taken out of it) -- NOT pinned to the window edges the way
        //    Cobalt's is, so it must be narrower than the viewport by roughly that column's width.
        expect(result.width).toBeLessThan(viewport.width - 250)
      })
    })

    /*
      Combined fixture: BOTH overlay drawers open together with the footer, mirroring the real page
      shell (`MainLayout.vue`'s `.bg-sidebar` + `Index.vue`'s `.page-container`/`.page-sidebar`) rather
      than either drawer tested against the footer alone, as #3017/#3018's own suites do. Only
      meaningful below `$toc-overlay-max` (749.98px), where both drawers are `position: fixed`
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
            // -> `WLayout.vue`'s own `:deep(> .w-page-container) { min-height: 0; overflow: auto }`
            //    reproduced inline -- see `MainLayout.footerClearance.test.js`'s own comment for why a
            //    bare `sass.compileString` extraction never runs a Vue SFC's `:deep()` transform.
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
                // -> Which of the nav drawer and the footer bar actually paints on top at a point
                //    both cover -- the near bottom-left corner, inside the drawer's own width and
                //    the bar's own height.
                navIsAboveFooterAtCorner: Boolean(
                  document.elementFromPoint(10, window.innerHeight - 10)?.closest('.bg-sidebar')
                )
              }
            }
          )

          // -> The TOC drawer keeps its own #3018 clearance, unchanged by OpenProject #3032 (which is
          //    scoped to the NAV drawer alone) -- its own bottom edge still sits at or above the bar's
          //    top edge.
          expect(result.tocBottom).toBeLessThanOrEqual(result.footerTop + 0.5)
          // -> The nav drawer, by contrast, now reaches the true bottom of the window rather than
          //    stopping short of it (OpenProject #3032, reverting #3018's opposite fix for this one
          //    drawer) -- it and the footer bar genuinely overlap here, at this width, and a higher
          //    z-index is what keeps the drawer drawn on top rather than painted over.
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

          // -> The button's own bottom edge sits at or above the footer bar's top edge -- it stands
          //    clear of the bar entirely, the same clearance the two drawers get, rather than being
          //    painted over by the footer's higher z-index.
          expect(result.btnRect.bottom).toBeLessThanOrEqual(result.footerTop + 0.5)
          // -> And it still has real, positive height -- clearing the bar didn't also collapse it.
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

          // -> Ledger has no fixed footer bar (`--footer-bar-height: 0`), so the button stays flush
          //    with the window's own bottom edge exactly as its bare `bottom-0` utility class says.
          expect(result.bottom).toBeCloseTo(result.viewportHeight, 0)
        })
      }
    )
  }
)
