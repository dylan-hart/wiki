import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * A target box is a laid-out thing and neither `jsdom` nor `happy-dom` runs a layout engine -- every
 * `getBoundingClientRect()` under them comes back zeroed -- so the row is measured in real headless
 * Chromium. Asserting against markup instead would pass just as happily against a stylesheet that
 * un-did the equal-box rule somewhere else.
 *
 * The page handed to Chromium is three load-bearing parts: `buildAppCss()` (the row's flex layout
 * and `WBtn`'s utility classes), the `<style>` elements Vitest injects during the mount (every
 * SFC's styles, `PageHeader.vue`'s scoped equal-box rule included -- `app.css` is in neither
 * bundle, which is why that rule lives in the component), and `wrapper.html()`, which carries the
 * `data-v-*` attributes those scoped selectors need.
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

    /** Every optional member of the row at once, so watch, print and Edit are one measurement. */
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
            store.editor = 'markdown'
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

    it('draws watch, print and Edit all in the row', async () => {
      const boxes = await measureActionRow()

      expect(boxes.map((box) => box.label)).toEqual([
        'common.page.watch',
        'common.actions.print',
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
