import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, hasChromium, CHROMIUM_TIMEOUT } from '../../test/realGridLayout.js'
import { measureGraphControlRow } from './graphControlLayoutHarness.js'
import { mountGraph } from './graphFixtures.js'

/**
 * OpenProject #2892: #2855 merged the Unique/Total and Edits/Visits toggles into one semantic SIZE BY
 * row, but a real headless-Chromium render at the panel's actual content width (236px panel, 14px
 * padding + 1px border each side -> ~206px available) measured the two toggles combining to ~229px --
 * genuinely wrapping to two lines at the real width, not just in a hypothetical wide-locale scenario.
 * jsdom/happy-dom (this suite's default environment) cannot catch this at all: neither runs a layout
 * engine, so every element's `getBoundingClientRect()` comes back zeroed regardless of CSS -- hence
 * the real-Chromium describe below, same pattern as `ApiKeyCreateDialog.test.js`'s classification-grid
 * suite.
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
      // -> Pageview tracking on so `sizeByOptions` offers BOTH 'edits' and 'visits' -- this is the
      //    two-segment/two-segment row Dylan actually saw; the default mount only ever has one
      //    'edits' option (tracking off), which is far narrower and never reproduces the bug.
      const wrapper = await mountGraph({ pageviewsEnabled: true })
      const html = wrapper.find('.graph-view-right-rail').html()

      const result = await measureGraphControlRow({ browser, html })

      expect(result.wrapped).toBe(false)
      // -> Not just "didn't wrap" but with real headroom -- a bare pass-by-a-pixel would be as
      //    fragile as the bug this replaces, the first time a locale's labels run a few characters
      //    longer than English's.
      const availableWidth = 236 - 2 * 14 - 2 * 1 // panel width - padding - border, both sides
      const combined = result.toggleWidths[0] + 6 /* row gap */ + result.toggleWidths[1]
      expect(combined).toBeLessThan(availableWidth - 10)
    }) // -> real chromium layout via graphControlLayoutHarness.js; describe-level CHROMIUM_TIMEOUT covers this
  }
)
