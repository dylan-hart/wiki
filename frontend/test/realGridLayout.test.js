import { describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, hasChromium } from './realGridLayout.js'

/**
 * `CHROMIUM_TIMEOUT` is the single timeout every real-Chromium describe passes alongside
 * `skip: !hasChromium()`, so a suite gets a timeout generous enough to survive a browser launch
 * under full-suite parallelism by construction rather than by remembering to copy a literal. This is
 * a pure assertion on the constant and the probe result's shape -- the module's own real-browser
 * behaviour is exercised by its consumers, not re-tested here.
 */
describe('realGridLayout', () => {
  it('exports a Chromium timeout well above Vitest default 5s test timeout', () => {
    expect(CHROMIUM_TIMEOUT).toBeGreaterThan(5000)
  })

  it('reports Chromium availability as a boolean', () => {
    expect(typeof hasChromium()).toBe('boolean')
  })
})
