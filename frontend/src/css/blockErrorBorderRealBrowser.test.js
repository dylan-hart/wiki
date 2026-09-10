import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2905 ("--block-error-border draws the light-mode accent color even in dark mode --
 * same nested-var() cascade bug class as #2886").
 *
 * `blockTokens.test.js` asserts the `--block-*` custom properties against the SOURCE TEXT of
 * `tailwind.css` -- it cannot catch this bug, because the bug is not in what any one token is
 * declared as: it is in how the browser resolves a `var()` NESTED inside another custom property
 * across an inheritance boundary, which no amount of reading the source text can simulate (`jsdom`
 * cannot either -- it runs no layout/paint engine, so it never actually resolves a `var()` cascade
 * at all). This suite is the one place that mounts the REAL compiled CSS in a REAL browser and reads
 * back the REAL computed color, the only way this class of bug is actually observable -- same
 * approach `tabsetHairlineRealBrowser.test.js` used for #2886.
 *
 * The failure mode, concretely: `--block-error-border` holds the literal string
 * `1px dashed var(--block-accent-fill)`. A custom property's nested `var()` is substituted using the
 * COMPUTED value at the element where that property is itself ASSIGNED in the cascade, and that
 * already-resolved value is what then inherits down -- it is not re-substituted per descendant.
 * Before the fix, `--block-error-border` was assigned only once, at `:root` (`<html>`), so its
 * nested `var(--block-accent-fill)` kept resolving against `<html>`'s own Ledger-light fill
 * (`#e4676b`) forever, even under `body.body--dark` (which overrides `--block-accent-fill` on
 * `<body>`, never reaching `<html>` itself) or `body.body--cobalt.body--dark`.
 *
 * The fixture below is a minimal custom element drawing its border straight off
 * `var(--block-error-border)`, the same shape `blocks/shared/styles.js`'s `errorBox` would use if it
 * consumed the token (it currently hardcodes its own border instead -- this suite is about the CSS
 * cascade `tailwind.css` declares, not about any one block's wiring), kept self-contained here rather
 * than importing real block code so it needs no cross-workspace build step to stay in sync with.
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

        // -> Ledger dark's --color-accent-dark, #f08287. Before the #2905 fix this came back as
        //    rgb(228, 103, 107) -- Ledger LIGHT's #e4676b -- a similar-but-wrong red shade.
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

        // -> Cobalt's own bright fill, #ff4d5a, re-pointed back to --color-accent-fill and kept
        //    bright in both Cobalt light and dark forms. Before the #2905 fix this came back as
        //    rgb(228, 103, 107) -- still Ledger LIGHT's #e4676b, the same stuck-at-:root bug.
        expect(color).toBe('rgb(255, 77, 90)')
      },
      CHROMIUM_TIMEOUT
    )
  }
)
