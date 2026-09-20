import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import {
  CHROMIUM_TIMEOUT,
  buildAppCss,
  chromium,
  hasChromium
} from '../../../test/realGridLayout.js'

/**
 * Row stacking is keyed off a container query on `.w-item`, narrowed to the two-main-section shape
 * (`:has(.w-item-section--main + .w-item-section--main)`): `container-type: inline-size` implies
 * inline-axis size containment, so applying it unconditionally stops any other row's content from
 * contributing to an auto-width ancestor's shrink-to-fit width, collapsing the row to its padding.
 */

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

function mountSideAndSingleMainRow() {
  return mount({
    template: `
      <w-item>
        <w-item-section side>
          <span>ICON</span>
        </w-item-section>
        <w-item-section>
          <w-item-label>Menu item label</w-item-label>
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

    // -> `container: w-item / inline-size`, not the source's two longhands: lightningcss (wired
    //    into `vitest.config.js` to downlevel native CSS nesting for happy-dom) coalesces them.
    expect(compiledCss).toMatch(
      /\.w-item\[data-v-[\da-f]+]:has\(\.w-item-section--main \+ \.w-item-section--main\)\s*{[^}]*container:\s*w-item \/ inline-size/
    )
    // -> `flex-wrap` cannot sit behind the container query itself: an element never matches a
    //    query on the container it declares.
    expect(compiledCss).toMatch(
      /\.w-item\[data-v-[\da-f]+]:has\(\.w-item-section--main \+ \.w-item-section--main\)\s*{[^}]*flex-wrap:\s*wrap/
    )
    expect(compiledCss).not.toMatch(
      /@container[^{]*{\s*\.w-item\[data-v-[\da-f]+]\s*{[^}]*flex-wrap/
    )
    // -> `(width <= 599.98px)`, not the source's own `(max-width: 599.98px)`: lightningcss
    //    canonicalizes to range syntax.
    expect(compiledCss).toMatch(
      /@container w-item \(width <= 599\.98px\)\s*{\s*\.w-item-section--main \+ \.w-item-section--main\[data-v-[\da-f]+]\s*{[^}]*flex:\s*1 0 100%/
    )
    expect(compiledCss).not.toMatch(
      /@media[^{]*max-width:\s*599\.98px[^{]*{\s*\.w-item-section--main/
    )
    expect(compiledCss).not.toMatch(/@media[^{]*width <= 599\.98px[^{]*{\s*\.w-item-section--main/)
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
  Neither jsdom nor happy-dom runs a layout engine, so the assertions above prove only that the
  right CSS text was emitted. This measures a real headless Chromium page at two wrapping-`<div>`
  widths, with the viewport unchanged between them.

  A `@container` condition is evaluated against the container's CONTENT box, and `.w-item` carries
  32px of its own horizontal padding (`px-4`), so the wrapper width at which the row stacks is
  ~631.98px rather than the 599.98px in the query. The two widths below sit clear of that on either
  side; values near 599.98 leave the row stacked at every width and silently prove nothing.
*/
const WRAPPER_WIDTH_UNSTACKED = 700
const WRAPPER_WIDTH_STACKED = 580
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
      expect(sections[1].x).toBeGreaterThan(sections[0].x)
    })

    it('stacks the input section under the label section at a row width below the container threshold', async () => {
      const sections = await measureMainSections(WRAPPER_WIDTH_STACKED)

      expect(sections).toHaveLength(2)
      expect(sections[1].y).toBeGreaterThan(sections[0].y)
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

/*
  The shape unconditional size containment collapses: a `side` + single-main menu row inside an
  auto-width ("shrink-to-fit") ancestor -- a `w-menu` popup with no `matchTrigger`. The label stops
  contributing to the popup's width, so the row measures its own padding with a 0-width label.
*/
describe(
  'WItem/WItemSection responsive row stacking — menu row inside an auto-width ancestor (real layout)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let componentCss
    let rowHtml

    beforeAll(async () => {
      browser = await chromium.launch()
      const wrapper = mountSideAndSingleMainRow()
      rowHtml = wrapper.html()
      componentCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('sizes to its own content inside a shrink-to-fit ancestor, instead of collapsing to its padding', async () => {
      const tailwindCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        // -> `display: inline-block` with no `width` mirrors an un-widened `w-menu` popup, which
        //    shrink-wraps to its content.
        await page.setContent(
          `<!doctype html><html><head><style>${tailwindCss}\n${componentCss}</style></head><body>` +
            `<div style="display: inline-block">${rowHtml}</div></body></html>`
        )
        const { itemWidth, labelWidth } = await page.evaluate(() => {
          const item = document.querySelector('.w-item')
          const label = document.querySelector('.w-item-label')
          return {
            itemWidth: item.getBoundingClientRect().width,
            labelWidth: label.getBoundingClientRect().width
          }
        })

        // -> 32px is the row's `px-4` padding alone: exactly what a collapsed row measures.
        expect(itemWidth).toBeGreaterThan(32)
        expect(labelWidth).toBeGreaterThan(0)
      } finally {
        await page.close()
      }
    })
  }
)
