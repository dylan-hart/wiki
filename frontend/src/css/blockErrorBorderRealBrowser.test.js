import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * A custom property's nested `var()` is substituted using the COMPUTED value at the element where
 * that property is itself ASSIGNED, and that already-resolved value is what inherits down -- it is
 * never re-substituted per descendant. So `--block-error-border`, which holds the literal
 * `1px dashed var(--block-accent-fill)`, has to be re-assigned under every theme scope: assigned
 * only at `:root` (`<html>`), its nested `var()` stays stuck on the Ledger-light fill even under
 * `body.body--dark`, which overrides the fill on `<body>` and never reaches `<html>`.
 *
 * Neither a source-text assertion nor jsdom can observe that -- only a real browser resolving the
 * real compiled CSS. The fixture is a self-contained custom element rather than real block code, so
 * it needs no cross-workspace build step.
 */

const FIXTURE_SCRIPT = `
  class BlockErrorBorderFixture extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = \`
        <style>
          .error { border: var(--block-error-border); }
        </style>
        <div class="error">Error</div>
      \`
    }
  }
  customElements.define('block-error-border-fixture', BlockErrorBorderFixture)
`

let browser

describe(
  '--block-error-border color under real Chromium (OpenProject #2905)',
  { skip: !hasChromium() },
  () => {
    beforeAll(async () => {
      browser = await chromium.launch()
    }, CHROMIUM_TIMEOUT)

    afterAll(async () => {
      await browser?.close()
    })

    async function computedErrorBorderColor(bodyClass) {
      const css = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
            `<body class="${bodyClass}"><block-error-border-fixture></block-error-border-fixture>` +
            `<script>${FIXTURE_SCRIPT}</script></body></html>`
        )
        await page.waitForFunction(
          () => customElements.get('block-error-border-fixture') !== undefined
        )
        return await page.evaluate(() => {
          const shadow = document.querySelector('block-error-border-fixture').shadowRoot
          return getComputedStyle(shadow.querySelector('.error')).borderColor
        })
      } finally {
        await page.close()
      }
    }

    it(
      'draws the Ledger-dark accent, not Ledger-light’s, under body--dark',
      async () => {
        const color = await computedErrorBorderColor('body--ledger body--dark')

        // -> Ledger dark's --color-accent-dark, #f08287
        expect(color).toBe('rgb(240, 130, 135)')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'still draws the Ledger-light accent under no dark class (unaffected by the fix)',
      async () => {
        const color = await computedErrorBorderColor('body--ledger body--light')

        // -> Ledger light's --color-accent-fill, #e4676b
        expect(color).toBe('rgb(228, 103, 107)')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'draws Cobalt’s bright fill, not Ledger dark’s, under body--cobalt body--dark',
      async () => {
        const color = await computedErrorBorderColor('body--cobalt body--dark')

        // -> Cobalt's own bright fill, #ff4d5a, which stays bright in both its light and dark forms
        expect(color).toBe('rgb(255, 77, 90)')
      },
      CHROMIUM_TIMEOUT
    )
  }
)
