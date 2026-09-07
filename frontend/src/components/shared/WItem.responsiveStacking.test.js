import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import {
  CHROMIUM_TIMEOUT,
  buildAppCss,
  chromium,
  hasChromium
} from '../../../test/realGridLayout.js'

/**
 * OpenProject #2822: an icon/label section beside an input section, the shape every
 * settings-style `WItem` row shares, drops the second section onto a line of its own once the ROW
 * itself runs out of room -- a `container-type: inline-size` container query on `.w-item`
 * (`WItem.vue`), not a viewport media query. `ProfileOverlay.vue` used to carry its own scoped copy
 * of this, keyed off `window.innerWidth`; this suite covers the shared primitive that replaced it.
 */

/** Two adjacent MAIN sections -- an icon+label section, then an input section -- inside one row. */
function mountTwoMainSectionRow() {
  return mount({
    template: `
      <w-item>
        <w-item-section side>
          <span>ICON</span>
        </w-item-section>
        <w-item-section>
          <w-item-label>Field label</w-item-label>
        </w-item-section>
        <w-item-section>
          <input type="text" aria-label="Field value" />
        </w-item-section>
      </w-item>
    `
  })
}

describe('WItem/WItemSection responsive row stacking', () => {
  it("keys the row's stacking off a CSS container query on .w-item, not a viewport media query", () => {
    mountTwoMainSectionRow()

    const compiledCss = [...document.querySelectorAll('style')]
      .map((el) => el.textContent)
      .join('\n')

    // -> `.w-item` is the query container the row's own rendered width is measured against
    expect(compiledCss).toMatch(/\.w-item\[data-v-[\da-f]+]\s*{[^}]*container-type:\s*inline-size/)
    // -> `flex-wrap: wrap` is unconditional (see WItem.vue's own comment on why a same-element
    //    container query never actually applied) -- it must NOT be gated behind a `@container` block
    expect(compiledCss).toMatch(/\.w-item\[data-v-[\da-f]+]\s*{[^}]*flex-wrap:\s*wrap/)
    expect(compiledCss).not.toMatch(
      /@container[^{]*{\s*\.w-item\[data-v-[\da-f]+]\s*{[^}]*flex-wrap/
    )
    // -> A second adjacent main section claims the full row width under a container query keyed off
    expect(compiledCss).toMatch(
      /@container w-item \(max-width: 599\.98px\)\s*{\s*\.w-item-section--main \+ \.w-item-section--main\[data-v-[\da-f]+]\s*{[^}]*flex:\s*1 0 100%/
    )
    // -> No leftover viewport-keyed media query duplicating the same rule
    expect(compiledCss).not.toMatch(
      /@media[^{]*max-width:\s*599\.98px[^{]*{\s*\.w-item-section--main/
    )
  })

  it('renders as two MAIN sections with no fixed pixel width baked in (the row itself decides)', () => {
    const wrapper = mountTwoMainSectionRow()

    const mainSections = wrapper.findAll('.w-item-section--main')
    expect(mainSections).toHaveLength(2)
    for (const section of mainSections) {
      expect(section.attributes('style') ?? '').not.toMatch(/width/)
    }
  })
})

/*
  Real-Chromium layout, mirroring `ApiKeyCreateDialog.test.js`'s "real layout" describe and
  `test/realGridLayout.js`'s own reasoning: neither jsdom nor happy-dom runs a layout engine, so
  nothing above actually proves the row wraps at the right width -- only that the right CSS text was
  emitted. This launches a real headless Chromium page, drops the row's OWN compiled scoped CSS
  (harvested from the mount above, exactly as the app ships it -- `data-v-*` attributes included)
  alongside the app's real compiled Tailwind CSS into it, and measures where the two main sections
  actually land at two different CONTAINER widths -- proving the row reacts to its own rendered
  width, with no viewport involved at all (Chromium's default viewport never changes between the two
  measurements below; only the wrapping `<div>`'s width does).

  A `@container` condition is evaluated against the query container's CONTENT box, same as `cqw`
  units and `%` widths -- not its border box. `.w-item` carries its own `px-4` (32px of horizontal
  padding), so a wrapping `<div>` narrower than roughly `599.98 + 32 = 631.98px` already puts the
  row's CONTENT width at or under the 599.98px threshold. `WRAPPER_WIDTH_UNSTACKED` /
  `WRAPPER_WIDTH_STACKED` below sit well clear of that boundary on either side -- verified directly
  against a real Chromium page (not assumed) while this suite was written, after an initial attempt
  with values close to 599.98 itself (which do not account for the padding) produced a row that
  stayed stacked at every width tried, silently disproving the very thing being tested.
*/
const WRAPPER_WIDTH_UNSTACKED = 700 // -> content width ~668px, clear of the ~631.98px boundary
const WRAPPER_WIDTH_STACKED = 580 // -> content width ~548px, clear of the ~631.98px boundary
describe(
  'WItem/WItemSection responsive row stacking — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let componentCss
    let rowHtml

    beforeAll(async () => {
      browser = await chromium.launch()
      const wrapper = mountTwoMainSectionRow()
      rowHtml = wrapper.html()
      componentCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    async function measureMainSections(containerWidth) {
      const tailwindCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${tailwindCss}\n${componentCss}</style></head><body>` +
            `<div style="width:${containerWidth}px">${rowHtml}</div></body></html>`
        )
        return await page.evaluate(() => {
          return [...document.querySelectorAll('.w-item-section--main')].map((el) => {
            const rect = el.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width }
          })
        })
      } finally {
        await page.close()
      }
    }

    it('keeps the label and input sections on one line at a row width above the container threshold', async () => {
      const sections = await measureMainSections(WRAPPER_WIDTH_UNSTACKED)

      expect(sections).toHaveLength(2)
      expect(Math.round(sections[0].y)).toBe(Math.round(sections[1].y))
      // -> Side by side, not stacked: the second section sits to the right of the first
      expect(sections[1].x).toBeGreaterThan(sections[0].x)
    })

    it('stacks the input section under the label section at a row width below the container threshold', async () => {
      const sections = await measureMainSections(WRAPPER_WIDTH_STACKED)

      expect(sections).toHaveLength(2)
      expect(sections[1].y).toBeGreaterThan(sections[0].y)
      // -> Full width once stacked, not squeezed beside the first section
      expect(sections[1].x).toBeLessThanOrEqual(sections[0].x + 1)
    })

    it('reacts to the CONTAINER width, not the page viewport, which is identical for both measurements', async () => {
      const wide = await measureMainSections(WRAPPER_WIDTH_UNSTACKED)
      const narrow = await measureMainSections(WRAPPER_WIDTH_STACKED)

      const wideStacked = Math.round(wide[0].y) !== Math.round(wide[1].y)
      const narrowStacked = narrow[1].y > narrow[0].y

      expect(wideStacked).toBe(false)
      expect(narrowStacked).toBe(true)
    })
  }
)
