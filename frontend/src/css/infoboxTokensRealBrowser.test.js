import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2955 ("Infobox theme tokens (--infobox-border, --block-radius,
 * --block-corner-marks) only declared at :root -- Ledger dark borders white, Cobalt corners square
 * with visible marks").
 *
 * `infoboxBorderToken.test.js`/`blockTokens.test.js` assert these custom properties against the
 * SOURCE TEXT of `tailwind.css` -- they cannot catch this bug class on their own, because the bug is
 * not in what any one token is declared as: it is in how the browser resolves a `var()` NESTED
 * inside another custom property across an inheritance boundary, which no amount of reading the
 * source text (and no `jsdom`, which runs no layout/paint engine at all) can simulate. This suite
 * mounts the REAL compiled CSS in a REAL browser and reads back the REAL computed styles, the same
 * approach `blockErrorBorderRealBrowser.test.js` (#2905) and `tabsetHairlineRealBrowser.test.js`
 * (#2886) used for the identical bug class.
 *
 * The fixture reads `--infobox-border`, `--block-radius` and `--block-corner-marks` exactly the way
 * `blocks/block-infobox/component.js` does (`border: 1px solid var(--infobox-border)`,
 * `border-radius: var(--block-radius)`, `.marks { display: var(--block-corner-marks) }`), kept
 * self-contained here rather than importing the real block so it needs no cross-workspace build
 * step to stay in sync with.
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

        // -> Ledger dark's --color-hairline-dark, #2a3040. Before the #2955 fix this came back as
        //    rgb(219, 225, 236) -- Ledger LIGHT's #dbe1ec -- a near-white hairline against a dark card.
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

        // -> Cobalt's own --radius-card (8px) and --corner-marks (none). Before the #2955 fix these
        //    came back as "0px" and "block" -- Ledger's own square corners and visible marks, even
        //    though --radius-card/--corner-marks themselves ARE correctly redefined for Cobalt.
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
        // -> Cobalt dark's own --infobox-border literal, rgb(143 176 255 / 0.28) -- unaffected by
        //    this fix, confirming the body.body--dark restatement doesn't leak into the more
        //    specific body.body--cobalt.body--dark selector.
        expect(borderColor).toBe('rgba(143, 176, 255, 0.28)')
      },
      CHROMIUM_TIMEOUT
    )
  }
)
