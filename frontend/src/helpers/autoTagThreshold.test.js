import { describe, expect, it } from 'vitest'

import {
  isValidAutoTagMaxTags,
  isValidAutoTagPercent,
  percentToThreshold,
  thresholdToPercent
} from './autoTagThreshold'

describe('thresholdToPercent', () => {
  it('shows the stored 0.15 default as 15%', () => {
    expect(thresholdToPercent(0.15)).toBe(15)
  })

  it('is a straight x100, not the (1 - x) inversion semantic search distance uses', () => {
    expect(thresholdToPercent(0.3)).toBe(30)
    expect(thresholdToPercent(0.3)).not.toBe(70)
  })

  it('maps the bounds to 0% and 100%', () => {
    expect(thresholdToPercent(0)).toBe(0)
    expect(thresholdToPercent(1)).toBe(100)
  })

  it('hides floating-point noise from the multiplication', () => {
    expect(thresholdToPercent(0.07)).toBe(7)
    expect(thresholdToPercent(0.125)).toBe(12.5)
  })
})

describe('percentToThreshold', () => {
  it('stores 15% as 0.15', () => {
    expect(percentToThreshold(15)).toBe(0.15)
  })

  it('round-trips through thresholdToPercent', () => {
    for (const threshold of [0, 0.01, 0.07, 0.15, 0.125, 0.3, 0.99, 1]) {
      expect(percentToThreshold(thresholdToPercent(threshold))).toBe(threshold)
    }
  })
})

describe('isValidAutoTagPercent', () => {
  it('accepts 0 to 100 inclusive, fractions included', () => {
    for (const value of [0, 12.5, 15, 100]) {
      expect(isValidAutoTagPercent(value)).toBe(true)
    }
  })

  it('rejects out-of-range and non-numeric values', () => {
    for (const value of [-1, 100.5, Number.NaN, '', '15', null, undefined]) {
      expect(isValidAutoTagPercent(value)).toBe(false)
    }
  })
})

describe('isValidAutoTagMaxTags', () => {
  it('accepts whole numbers from 1 to 20', () => {
    for (const value of [1, 3, 20]) {
      expect(isValidAutoTagMaxTags(value)).toBe(true)
    }
  })

  it('rejects zero, fractions, values over 20 and non-numbers', () => {
    for (const value of [0, 2.5, 21, '3', null]) {
      expect(isValidAutoTagMaxTags(value)).toBe(false)
    }
  })
})
