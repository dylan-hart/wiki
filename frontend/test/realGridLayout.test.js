import { describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, hasChromium } from './realGridLayout.js'

/**
 * Pure coverage for the two things every real-Chromium suite depends on from this harness, without
 * actually launching a browser (that happens inside each consuming suite's own `beforeAll`,
 * gated on `hasChromium()`).
 *
 * `CHROMIUM_TIMEOUT` is what closes OpenProject #2730: three suites used to each hardcode their own
 * `timeout: 30000` literal (or, for `PageHeader.actionBox.test.js`, carry no timeout at all and rely
 * on vitest's 5s default, which a Chromium launch plus a Tailwind compile can exceed under full-suite
 * parallelism). This asserts the shared constant is the same generous budget the sibling suites used
 * to each spell out by hand.
 */
describe('realGridLayout', () => {
  it('exports a generous shared timeout for real-Chromium describes', () => {
    expect(CHROMIUM_TIMEOUT).toBe(30000)
  })

  it('answers whether a real Chromium binary is installed as a boolean', () => {
    expect(typeof hasChromium()).toBe('boolean')
  })
})
