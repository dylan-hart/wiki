import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'

import FooterNav from './FooterNav.vue'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../../test/i18n.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §3's "Footer (`FooterNav.vue`)" role table:
 *
 * | Role           | Font           | Light                          | Dark    |
 * | -------------- | -------------- | ------------------------------- | ------- |
 * | Copyright line | 400 11px mono  | `--color-footer-text` `#a7b3ea` | `#8b98d6` |
 * | Footer link    | inherit        | `--color-footer-link` `#ff7a84` | `#ff7a84` |
 *
 * Measured in real headless Chromium, following `PageHeader.typography.test.js`'s established
 * pattern (`buildAppCss()` for `tailwind.css`'s tokens, the `<style>` elements Vitest injects for
 * `FooterNav.vue`'s own scoped rule with `:global()` already resolved, `wrapper.html()` for the
 * markup) -- a computed `color` driven by a CSS custom property cascade is not something
 * `jsdom`/`happy-dom` can answer without also hand-building the token layer, and the whole point
 * here is to catch a real cascade-specificity bug (OpenProject #2980), not just read the source.
 */
describe(
  'FooterNav typography (OpenProject #2980)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    function mountFooter() {
      setActivePinia(createPinia())
      const i18n = createTestI18n({
        common: {
          footerCopyright: '© {year} {company}. All rights reserved.',
          footerLicense: 'Content is available under the {license}, by {company}.',
          footerGeneric: 'Powered by {link}, an open source project.',
          footerPoweredBy: 'Powered by {link}',
          license: { alr: 'All Rights Reserved' }
        }
      })
      const wrapper = mount(FooterNav, { global: { plugins: [i18n] } })
      const siteStore = useSiteStore()
      siteStore.company = 'Acme Corp'
      siteStore.contentLicense = 'alr'
      return wrapper
    }

    async function measure({ dark: darkMode = false, cobalt = false } = {}) {
      const wrapper = mountFooter()
      await wrapper.vm.$nextTick()

      const html = wrapper.html()
      const sfcCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
      const appCss = await buildAppCss()

      const page = await browser.newPage()
      try {
        const bodyClasses = [darkMode ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${sfcCss}</style></head>` +
            `<body class="${bodyClasses}"><div style="width:1280px">${html}</div></body></html>`
        )
        return await page.evaluate(() => {
          const footer = document.querySelector('.site-footer')
          const link = document.querySelector('.site-footer-line a')
          const footerStyle = getComputedStyle(footer)
          const linkStyle = getComputedStyle(link)
          return {
            footer: {
              color: footerStyle.color,
              fontFamily: footerStyle.fontFamily,
              fontSize: footerStyle.fontSize,
              fontWeight: footerStyle.fontWeight
            },
            link: {
              color: linkStyle.color,
              fontFamily: linkStyle.fontFamily,
              fontSize: linkStyle.fontSize
            }
          }
        })
      } finally {
        await page.close()
        wrapper.unmount()
      }
    }

    it('draws the copyright line 400 11px mono in both aesthetics', async () => {
      const ledger = await measure()
      const cobaltLight = await measure({ cobalt: true })

      for (const result of [ledger, cobaltLight]) {
        expect(result.footer.fontFamily.split(',')[0].replace(/['"]/g, '')).toBe('Roboto Mono')
        expect(result.footer.fontSize).toBe('11px')
        expect(result.footer.fontWeight).toBe('400')
      }
    })

    it('colors the copyright line --color-footer-text light, the caption/kicker dark tier under Cobalt dark', async () => {
      const cobaltLight = await measure({ cobalt: true })
      const cobaltDark = await measure({ cobalt: true, dark: true })

      // -> `--color-footer-text` in `body.body--cobalt`
      expect(cobaltLight.footer.color).toBe('rgb(167, 179, 234)') // #a7b3ea
      // -> `--color-text-caption-dark`, restated `#8b98d6` under `body.body--cobalt.body--dark`
      //    (OpenProject #2980's fix: without it this read back as the light value above)
      expect(cobaltDark.footer.color).toBe('rgb(139, 152, 214)') // #8b98d6
      expect(cobaltDark.footer.color).not.toBe(cobaltLight.footer.color)
    })

    it('colors the footer link --color-footer-link, identical in Cobalt light and dark, and inherits its font', async () => {
      const cobaltLight = await measure({ cobalt: true })
      const cobaltDark = await measure({ cobalt: true, dark: true })

      for (const result of [cobaltLight, cobaltDark]) {
        // -> `--color-footer-link`, `#ff7a84`
        expect(result.link.color).toBe('rgb(255, 122, 132)')
        expect(result.link.fontFamily.split(',')[0].replace(/['"]/g, '')).toBe('Roboto Mono')
        expect(result.link.fontSize).toBe('11px')
      }
    })

    it('leaves Ledger (both themes) on its own, unrelated tokens', async () => {
      const light = await measure()
      const dark = await measure({ dark: true })

      // -> `--color-text-caption` / `--color-text-caption-dark`, unaffected by the Cobalt-only fix
      expect(light.footer.color).not.toBe('rgb(167, 179, 234)')
      expect(dark.footer.color).not.toBe('rgb(139, 152, 214)')
    })
  }
)
