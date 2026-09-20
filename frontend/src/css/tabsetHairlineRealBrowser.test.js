import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The bug class guarded here is invisible to a source-text suite, because it is not in what any one
 * token is declared as: a custom property's nested `var()` is substituted using the COMPUTED value
 * at the element where that property is ASSIGNED, and that already-resolved value is what inherits
 * down -- it is never re-substituted per descendant. So `--tabs-strip-rule`'s literal
 * `1px solid var(--tabs-border)`, assigned only at `:root`, keeps resolving against `<html>`'s own
 * value even under a `body--dark` that overrides `--tabs-border` for everything below it. A rule's
 * OWN direct `var(--tabs-border)` is fine: that substitution happens locally, where the override is
 * genuinely inherited.
 *
 * Only real compiled CSS in a real browser can show this -- `jsdom` resolves no `var()` cascade at
 * all. The fixture restates the consuming rules `blocks/block-tabs/component.js` declares rather
 * than importing the built block, so this suite needs no cross-workspace build step.
 */

const FIXTURE_SCRIPT = `
  class TabsetHairlineFixture extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = \`
        <style>
          .tabs { border: 1px solid var(--tabs-border); }
          .strip { border-bottom: var(--tabs-strip-rule); }
          .tab { border: 0; border-right: var(--tabs-tab-rule); }
        </style>
        <div class="tabs">
          <div class="strip"><span class="tab">Tab</span></div>
        </div>
      \`
    }
  }
  customElements.define('tabset-hairline-fixture', TabsetHairlineFixture)
`

let browser

describe(
  'block-tabs hairline color under real Chromium (OpenProject #2886)',
  { skip: !hasChromium() },
  () => {
    beforeAll(async () => {
      browser = await chromium.launch()
    }, CHROMIUM_TIMEOUT)

    afterAll(async () => {
      await browser?.close()
    })

    async function computedRuleColors(bodyClass) {
      const css = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
            `<body class="${bodyClass}"><tabset-hairline-fixture></tabset-hairline-fixture>` +
            `<script>${FIXTURE_SCRIPT}</script></body></html>`
        )
        await page.waitForFunction(
          () => customElements.get('tabset-hairline-fixture') !== undefined
        )
        return await page.evaluate(() => {
          const shadow = document.querySelector('tabset-hairline-fixture').shadowRoot
          return {
            tabsBorderColor: getComputedStyle(shadow.querySelector('.tabs')).borderColor,
            stripBorderBottomColor: getComputedStyle(shadow.querySelector('.strip'))
              .borderBottomColor,
            tabBorderRightColor: getComputedStyle(shadow.querySelector('.tab')).borderRightColor
          }
        })
      } finally {
        await page.close()
      }
    }

    it(
      'draws every Ledger-dark tabset rule -- the frame border, the strip rule and each tab rule -- in the same dark color',
      async () => {
        const result = await computedRuleColors('body--ledger body--dark')

        // -> Ledger dark's --tabs-border, #2a3040.
        expect(result.tabsBorderColor).toBe('rgb(42, 48, 64)')
        expect(result.stripBorderBottomColor).toBe('rgb(42, 48, 64)')
        expect(result.tabBorderRightColor).toBe('rgb(42, 48, 64)')
      },
      CHROMIUM_TIMEOUT
    )

    it(
      'still draws every Ledger-light tabset rule in the same light color (unaffected by the dark-mode fix)',
      async () => {
        const result = await computedRuleColors('body--ledger body--light')

        // -> #dbe1ec, Ledger light's --tabs-border
        expect(result.tabsBorderColor).toBe('rgb(219, 225, 236)')
        expect(result.stripBorderBottomColor).toBe('rgb(219, 225, 236)')
        expect(result.tabBorderRightColor).toBe('rgb(219, 225, 236)')
      },
      CHROMIUM_TIMEOUT
    )
  }
)
