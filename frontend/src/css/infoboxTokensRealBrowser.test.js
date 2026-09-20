import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The bug class this guards is not in what a token is declared as -- which the source-text suites
 * already cover -- but in how a browser resolves a `var()` NESTED inside another custom property
 * across an inheritance boundary. Nothing short of real compiled CSS in a real browser can
 * reproduce that; `jsdom` runs no layout or paint engine at all.
 *
 * The fixture reads the tokens the way `blocks/block-infobox/component.js` does, restated here
 * rather than imported so this suite needs no cross-workspace build step -- keep the two in step.
 */

const FIXTURE_SCRIPT = `
  class InfoboxTokensFixture extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = \`
        <style>
          .card { border: 1px solid var(--infobox-border); border-radius: var(--block-radius); }
          .marks { display: var(--block-corner-marks); }
        </style>
        <div class="card">
          <i class="marks"></i>
        </div>
      \`
    }
  }
  customElements.define('infobox-tokens-fixture', InfoboxTokensFixture)
`

let browser

describe(
  'infobox theme tokens under real Chromium (OpenProject #2955)',
  { skip: !hasChromium() },
  () => {
    beforeAll(async () => {
      browser = await chromium.launch()
    }, CHROMIUM_TIMEOUT)

    afterAll(async () => {
      await browser?.close()
    })

    async function computedStyles(bodyClass) {
      const css = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
            `<body class="${bodyClass}"><infobox-tokens-fixture></infobox-tokens-fixture>` +
            `<script>${FIXTURE_SCRIPT}</script></body></html>`
        )
        await page.waitForFunction(() => customElements.get('infobox-tokens-fixture') !== undefined)
        return await page.evaluate(() => {
          const shadow = document.querySelector('infobox-tokens-fixture').shadowRoot
          const card = getComputedStyle(shadow.querySelector('.card'))
          const marks = getComputedStyle(shadow.querySelector('.marks'))
          return {
            borderColor: card.borderColor,
            borderRadius: card.borderTopLeftRadius,
            marksDisplay: marks.display
          }
        })
      } finally {
        await page.close()
      }
    }

    it(
      'draws the dark hairline, not Ledger light’s, under body--dark',
      async () => {
        const { borderColor } = await computedStyles('body--dark')

        // -> Ledger dark's --color-hairline-dark, #2a3040.
        expect(borderColor).toBe('rgb(42, 48, 64)')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'still draws the Ledger-light hairline under no dark class (unaffected by the fix)',
      async () => {
        const { borderColor } = await computedStyles('')

        // -> Ledger light's --color-hairline, #dbe1ec
        expect(borderColor).toBe('rgb(219, 225, 236)')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'rounds the card and hides the corner marks under body--cobalt',
      async () => {
        const { borderRadius, marksDisplay } = await computedStyles('body--cobalt')

        // -> Cobalt's own --radius-card and --corner-marks.
        expect(borderRadius).toBe('8px')
        expect(marksDisplay).toBe('none')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'stays rounded with hidden corner marks under body--cobalt body--dark',
      async () => {
        const { borderRadius, marksDisplay, borderColor } =
          await computedStyles('body--cobalt body--dark')

        expect(borderRadius).toBe('8px')
        expect(marksDisplay).toBe('none')
        // -> Cobalt dark's own --infobox-border literal: the body.body--dark restatement must not
        //    leak into the more specific body.body--cobalt.body--dark selector.
        expect(borderColor).toBe('rgba(143, 176, 255, 0.28)')
      },
      CHROMIUM_TIMEOUT
    )
  }
)
