import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2886 ("Ledger dark mode: tabsets show white hairlines").
 *
 * `tabsetTokens.test.js` asserts the `--tabs-*` custom properties against the SOURCE TEXT of
 * `tailwind.css` -- it cannot catch this bug, because the bug is not in what any one token is
 * declared as: it is in how the browser resolves a `var()` NESTED inside another custom property
 * across an inheritance boundary, which no amount of reading the source text can simulate (`jsdom`
 * cannot either -- it runs no layout/paint engine, so it never actually resolves a `var()` cascade
 * at all). This suite is the one place that mounts the REAL compiled CSS in a REAL browser and reads
 * back the REAL computed color, the only way this class of bug is actually observable.
 *
 * The failure mode, concretely: `--tabs-strip-rule`/`--tabs-tab-rule` hold the literal string
 * `1px solid var(--tabs-border)`. A custom property's nested `var()` is substituted using the
 * COMPUTED value at the element where that property is itself ASSIGNED in the cascade, and that
 * already-resolved value is what then inherits down -- it is not re-substituted per descendant. So
 * a shorthand assigned only once, at `:root` (`<html>`), keeps resolving its nested
 * `var(--tabs-border)` against `<html>`'s own value forever, even on a page whose `<body>` carries
 * a `body--dark` class overriding `--tabs-border` for everything under it. A block's OWN direct
 * `border: 1px solid var(--tabs-border)` does not have this problem, since that substitution
 * happens locally, deep in the block's own shadow tree, where the override really is inherited.
 *
 * The fixture below is a minimal custom element declaring the same three consuming rules
 * `blocks/block-tabs/component.js` does (`.tabs` direct, `.strip`/`.tab` through the shorthands),
 * kept self-contained here rather than importing the real compiled block -- this suite is about the
 * CSS cascade `tailwind.css` declares, not about `block-tabs` specifically, and a self-contained
 * fixture needs no cross-workspace build step to stay in sync with.
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

        // -> The correct Ledger-dark --tabs-border, #2a3040. Before the #2886 fix, .strip and .tab
        //    came back as rgb(219, 225, 236) -- Ledger LIGHT's #dbe1ec -- the white-reading hairline.
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
