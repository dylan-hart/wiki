import { describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, hasChromium } from './realGridLayout.js'

describe('realGridLayout', () => {
  it('exports a Chromium timeout well above Vitest default 5s test timeout', () => {
    expect(CHROMIUM_TIMEOUT).toBeGreaterThan(5000)
  })

  it('reports Chromium availability as a boolean', () => {
    expect(typeof hasChromium()).toBe('boolean')
  })
})
