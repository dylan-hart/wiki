import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2976 ("Cobalt typography: page header banner (PageHeader.vue)"), per
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §3's "Page header banner" role table.
 *
 * The h1 title and description already carry their target metrics and colour tokens from
 * `pages/Index.vue`'s global `.page-header-title`/`.page-header-subtitle` rules (verified directly
 * against source, not re-asserted here — that belongs to whichever suite owns `Index.vue`'s own
 * stylesheet). The one gap this component owns is the Draft badge: the target is `600 9.5px mono,
 * .16em, uppercase`. `PageHeader.vue` originally carried its own scoped `.page-header-badge`
 * override for the two properties `WBadge` didn't yet apply at this exact value; OpenProject #2989
 * removed that override once `WBadge`'s own base class list started applying
 * `text-[9.5px]`/`tracking-[.16em]`/`uppercase` unconditionally, making the local rule dead code
 * (a visual no-op — same computed styles, now sourced from `WBadge` itself). This suite asserts
 * against the rendered `.w-badge` element for that reason, not `.page-header-badge`.
 *
 * Measured in real headless Chromium, following `PageHeader.actionBox.test.js`'s own pattern
 * exactly (same three load-bearing pieces: `buildAppCss()` for `tailwind.css`, the `<style>`
 * elements Vitest injects for `PageHeader.vue`'s own scoped rule, `wrapper.html()` for the
 * `data-v-*` attributes those scoped selectors need) — a computed `font-size`/`letter-spacing` is
 * not something `jsdom`/`happy-dom` can answer for a scoped Vue rule with no layout engine behind
 * either.
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
