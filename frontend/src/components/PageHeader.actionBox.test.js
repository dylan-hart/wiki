import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2616: every button in `.page-header-actions` must draw the same target box.
 *
 * Watch, Print and the review queue were `dense` icon-only `w-btn`s while Edit beside them was a
 * full labelled one, so the three drew a 28px/10px hover-and-click box against Edit's 32px/14px --
 * visibly smaller targets in a row that reads as one group. What is NOT the defect, and must
 * survive: Edit keeps the accent fill (Cardinal's one-filled-button-per-surface rule, stated in
 * `PageHeader.vue`'s own comment above it) and the rest stay bare icons in the chrome tone. The
 * complaint is the box, not the fill.
 *
 * Measured in real headless Chromium rather than asserted against markup, for the reason
 * `test/realGridLayout.js` exists at all: a hover box is a laid-out thing, and neither `jsdom` nor
 * `happy-dom` runs a layout engine -- every `getBoundingClientRect()` under them comes back zeroed.
 * Asserting on the absence of a `dense` prop would pass just as happily against a stylesheet that
 * un-did the fix somewhere else.
 *
 * The page handed to Chromium is assembled from three parts, and all three are load-bearing:
 *
 *   - `buildAppCss()` compiles `src/css/tailwind.css` only, which is where the row's own flex
 *     layout and `WBtn`'s utility classes come from;
 *   - the `<style>` elements Vitest injects into `document` during the mount (`test.css: true` is
 *     on) carry every SFC's styles, INCLUDING `PageHeader.vue`'s own scoped rule -- the fix under
 *     test. `_base.scss` and the rest of `app.scss` are in neither bundle, which is precisely why
 *     the equal-box rule lives in this component's scoped block rather than there;
 *   - `wrapper.html()` carries the `data-v-*` scope attributes those scoped selectors need.
 *
 * Nothing is added to `test/realGridLayout.js` itself -- it is shared with several other
 * real-browser suites, and the measurement below is specific to this row.
 */
describe(
  'PageHeader action-row target box (OpenProject #2616)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    /**
     * Every optional member of the row turned on at once: an authenticated reader who may write, on a
     * page that is not a redirection, with the print button enabled and a review queue to answer for.
     * That is watch + print + review + Edit -- the whole set the note names, in one measurement.
     */
    async function measureActionRow() {
      const router = await createTestRouter(['/'])
      const { wrapper } = mountWithApp(PageHeader, {
        router,
        stores: {
          user: (store) => {
            store.authenticated = true
            store.permissions = ['write:pages']
          },
          site: (store) => {
            store.theme.showPrintBtn = true
          },
          page: (store) => {
            store.canReview = true
            store.editor = 'markdown'
            store.pendingSubmissions = []
          }
        }
      })
      await wrapper.vm.$nextTick()

      const html = wrapper.html()
      const sfcCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
      const appCss = await buildAppCss()

      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${sfcCss}</style></head>` +
            `<body><div style="width:1280px">${html}</div></body></html>`
        )
        return await page.evaluate(() => {
          return [...document.querySelectorAll('.page-header-actions > .w-btn')].map((el) => {
            const rect = el.getBoundingClientRect()
            const computed = getComputedStyle(el)
            return {
              label: el.getAttribute('aria-label'),
              height: rect.height,
              paddingLeft: computed.paddingLeft,
              paddingRight: computed.paddingRight
            }
          })
        })
      } finally {
        await page.close()
      }
    }

    it('draws watch, print, the review queue and Edit all in the row', async () => {
      const boxes = await measureActionRow()

      expect(boxes.map((box) => box.label)).toEqual([
        'common.page.watch',
        'common.actions.print',
        'inbox.pendingReview',
        'common.actions.edit'
      ])
    })

    it('gives every button in the row the same height', async () => {
      const boxes = await measureActionRow()

      // -> A real layout, not a zeroed one: proof the measurement is measuring something
      expect(boxes[0].height).toBeGreaterThan(0)
      expect(new Set(boxes.map((box) => box.height)).size).toBe(1)
    })

    it('gives every button in the row the same left and right padding', async () => {
      const boxes = await measureActionRow()

      expect(new Set(boxes.map((box) => box.paddingLeft)).size).toBe(1)
      expect(new Set(boxes.map((box) => box.paddingRight)).size).toBe(1)
      // -> Symmetric too, so an icon sits centred in the same box a label sits in
      expect(boxes[0].paddingLeft).toBe(boxes[0].paddingRight)
    })
  }
)
