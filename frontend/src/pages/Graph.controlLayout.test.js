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
  'Graph.vue SIZE BY control row — real layout (OpenProject #2892)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('keeps the Unique/Total and Edits/Visits toggles on one line at the real ~206px panel content width', async () => {
      // -> Pageview tracking on so `sizeByOptions` offers BOTH 'edits' and 'visits': the default
      //    mount has only 'edits', which is far narrower and never reproduces the wrap.
      const wrapper = await mountGraph({ pageviewsEnabled: true })
      const html = wrapper.find('.graph-view-right-rail').html()

      const result = await measureGraphControlRow({ browser, html })

      expect(result.wrapped).toBe(false)
      // -> Headroom, not a bare "didn't wrap": a pass by one pixel fails the first time a locale's
      //    labels run a few characters longer than English's.
      const availableWidth = 236 - 2 * 14 - 2 * 1 // panel width - padding - border, both sides
      const combined = result.toggleWidths[0] + 6 /* row gap */ + result.toggleWidths[1]
      expect(combined).toBeLessThan(availableWidth - 10)
    })
  }
)
