import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The draft badge's metrics come from `WBadge`'s own base classes, not a scoped override here,
 * which is why this asserts against the rendered `.w-badge` rather than `.page-header-badge`.
 *
 * Measured in real headless Chromium the same way `PageHeader.actionBox.test.js` measures its row:
 * neither `jsdom` nor `happy-dom` answers a computed `font-size`/`letter-spacing` for a scoped Vue
 * rule with no layout engine behind it.
 */
describe(
  'PageHeader draft badge typography (OpenProject #2976)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    async function measureDraftBadge() {
      const router = await createTestRouter(['/'])
      const { wrapper } = mountWithApp(PageHeader, {
        router,
        stores: {
          page: (store) => {
            store.publishState = 'draft'
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
          const el = document.querySelector('.w-badge')
          if (!el) {
            return null
          }
          const computed = getComputedStyle(el)
          return {
            text: el.textContent.trim(),
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            letterSpacing: computed.letterSpacing,
            textTransform: computed.textTransform
          }
        })
      } finally {
        await page.close()
      }
    }

    it('renders the badge on a draft page', async () => {
      const badge = await measureDraftBadge()

      expect(badge).not.toBeNull()
      expect(badge.text).toBe('editor.props.draft')
    })

    it('draws it 600 9.5px mono, .16em tracked and uppercase, per the role table', async () => {
      const badge = await measureDraftBadge()

      expect(badge.fontFamily.split(',')[0].replace(/['"]/g, '')).toBe('Roboto Mono')
      expect(badge.fontSize).toBe('9.5px')
      expect(badge.fontWeight).toBe('600')
      expect(badge.letterSpacing).toBe('1.52px') // -> 0.16em at a 9.5px font size
      expect(badge.textTransform).toBe('uppercase')
    })
  }
)
