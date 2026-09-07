import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The `--color-dark-3-5`/`-text` rung (OpenProject #2816): `WCardHeader.vue`'s `.w-section-header`
 * band and `WInput.vue`/`WSelect.vue`'s read-only field surface both want `#0e1540`/`#c9d6ff` under
 * Cobalt dark, a value distinct from every existing ramp rung -- see the token's own comment in
 * `tailwind.css`. `cobaltDarkTokens.test.js` pins the token's declared VALUE against the source text;
 * this file is the real-Chromium computed-style check that a consumer actually resolves to it, and
 * that Ledger dark is untouched by the new rung existing (same reasoning and harness as
 * `sectionHeaderRhythm.test.js` -- neither `jsdom` nor `happy-dom` runs a layout/paint engine capable
 * of resolving a `var()` cascade through two stacked body classes).
 */

describe(
  '--color-dark-3-5 rung resolves correctly in a real browser',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css

    beforeAll(async () => {
      css = await buildAppCss()
      browser = await chromium.launch()
    }, 60000)

    afterAll(async () => {
      await browser?.close()
    })

    /**
     * `.w-section-header` is WCardHeader's band; `.dark\:bg-dark-3-5` is the Tailwind utility
     * `WInput.vue`/`WSelect.vue`'s readonly surface now carries -- both markup shapes are rendered
     * under whichever `bodyClass` the caller asks for, and their resolved styles read back together.
     */
    async function measure(bodyClass) {
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
            `<body class="${bodyClass}">` +
            `<h2 class="w-card-header w-section-header">Band</h2>` +
            `<div class="dark:bg-dark-3-5">Field</div>` +
            `</body></html>`
        )
        return await page.evaluate(() => {
          const band = document.querySelector('.w-section-header')
          const field = document.querySelector('.dark\\:bg-dark-3-5')
          const bandStyle = getComputedStyle(band)
          const fieldStyle = getComputedStyle(field)
          return {
            bandBackground: bandStyle.backgroundColor,
            bandColor: bandStyle.color,
            fieldBackground: fieldStyle.backgroundColor
          }
        })
      } finally {
        await page.close()
      }
    }

    it('draws the Cobalt-dark mockup value (#0e1540/#c9d6ff), not -2 or -4', async () => {
      const cobaltDark = await measure('body--cobalt body--dark')
      expect(cobaltDark).toEqual({
        bandBackground: 'rgb(14, 21, 64)', // #0e1540
        bandColor: 'rgb(201, 214, 255)', // #c9d6ff
        fieldBackground: 'rgb(14, 21, 64)' // #0e1540
      })
    })

    it('leaves Ledger dark exactly as it rendered before this rung existed', async () => {
      const ledgerDark = await measure('body--dark')
      expect(ledgerDark).toEqual({
        bandBackground: 'rgb(36, 43, 58)', // -2, #242b3a
        bandColor: 'rgb(142, 166, 207)', // slate-light, #8ea6cf
        fieldBackground: 'rgb(23, 27, 36)' // -3-5's Ledger default, equal to -4, #171b24
      })
    })
  }
)
