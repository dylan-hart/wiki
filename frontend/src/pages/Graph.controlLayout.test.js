import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { measureGraphControlRow } from './graphControlLayoutHarness.js'
import { mountGraph } from './graphFixtures.js'

/**
 * A real headless Chromium, because the default DOM environment runs no layout engine: every
 * element's `getBoundingClientRect()` comes back zeroed regardless of CSS, so nothing else here can
 * tell whether this row wraps.
 */
describe(
  'Graph.vue right-rail control rows: real layout (OpenProject #2892, #3527)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    async function measure() {
      // -> Pageview tracking on so `sizeByOptions` offers BOTH 'edits' and 'visits': the default
      //    mount has only 'edits', which is far narrower and never reproduces the wrap.
      const wrapper = await mountGraph({ pageviewsEnabled: true })
      const html = wrapper.find('.graph-view-right-rail').html()
      return measureGraphControlRow({ browser, html })
    }

    it('fills the panel content width with the SIZE BY toggles on one line', async () => {
      const result = await measure()

      expect(result.wrapped).toBe(false)
      const rowGap = 6
      const combined = result.toggleWidths[0] + rowGap + result.toggleWidths[1]
      expect(combined).toBeGreaterThan(result.contentWidth - 1)
      expect(combined).toBeLessThan(result.contentWidth + 1)
    })

    it('gives every SIZE BY option the same width across both toggles', async () => {
      const result = await measure()
      const widths = result.groups[1].toggles.flatMap((toggle) => toggle.segmentWidths)

      expect(widths).toHaveLength(4)
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(3)
    })

    it('stretches a single toggle (GROUP BY) to the full content width', async () => {
      const result = await measure()
      const [groupBy] = result.groups[0].toggles

      expect(groupBy.width).toBeGreaterThan(result.contentWidth - 1)
    })

    it('left-aligns every control caption', async () => {
      const result = await measure()

      for (const group of result.groups) {
        expect(group.captionOffset).toBeLessThan(1)
      }
    })
  }
)
