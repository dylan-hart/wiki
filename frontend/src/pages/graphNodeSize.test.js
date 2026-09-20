import { describe, expect, it } from 'vitest'

import { lerpRadius, sqrtRangeOf } from './graphNodeSize.js'

/*
 * `lerpRadius` takes its bounds as parameters, so nothing here depends on `Graph.vue`'s constants
 * -- but every case passes the real `MIN_NODE_RADIUS`/`MAX_NODE_RADIUS` pair rather than arbitrary
 * numbers, so the arithmetic below describes radii the app actually draws.
 */
describe('graphNodeSize', () => {
  describe('sqrtRangeOf', () => {
    it('returns the sqrt-space min/max across the given counts', () => {
      // -> A raw-space min/max would coincidentally read 0/10 here too; the next test is what
      //    actually distinguishes the two spaces.
      expect(sqrtRangeOf([0, 100, 25])).toEqual({ min: 0, max: 10 })
    })

    it('orders by the SQUARE ROOT, not the raw count -- proving this is sqrt space, not raw space', () => {
      // -> Raw space would report max 16 here rather than sqrt(16) = 4.
      expect(sqrtRangeOf([16, 1])).toEqual({ min: 1, max: 4 })
    })

    it('collapses a degenerate all-same-count list to a zero-width range AT that count’s own sqrt, not at 0', () => {
      const range = sqrtRangeOf([7, 7, 7])
      expect(range.min).toBe(range.max)
      expect(range.min).toBeCloseTo(Math.sqrt(7))
    })

    it('collapses an empty list (no real nodes loaded) to a zero-width range specifically at 0', () => {
      // -> The only input that produces exactly {min: 0, max: 0}.
      expect(sqrtRangeOf([])).toEqual({ min: 0, max: 0 })
    })

    it('handles a single count the same way as an all-same-count list -- at its own sqrt', () => {
      const range = sqrtRangeOf([42])
      expect(range.min).toBe(range.max)
      expect(range.min).toBeCloseTo(Math.sqrt(42))
    })
  })

  describe('lerpRadius', () => {
    it('maps the range minimum to minRadius and the range maximum to maxRadius', () => {
      const range = { min: 0, max: 10 }
      expect(lerpRadius(0, range, 20, 110)).toBe(20)
      // -> count 100 -> sqrt(100) = 10 = range.max
      expect(lerpRadius(100, range, 20, 110)).toBe(110)
    })

    it('interpolates linearly BETWEEN the two, in sqrt space', () => {
      const range = { min: 0, max: 10 }
      // -> count 25 -> sqrt(25) = 5, the exact midpoint of [0, 10] -> exact midpoint of [20, 110]
      expect(lerpRadius(25, range, 20, 110)).toBeCloseTo(65)
    })

    it('never divides by zero on a zero-width range, drawing at the floor instead', () => {
      const zeroWidthRange = { min: 0, max: 0 }
      expect(lerpRadius(0, zeroWidthRange, 20, 110)).toBe(20)
      // -> Once the range is zero-width the node's OWN count plays no part; only the range decides.
      expect(lerpRadius(999, zeroWidthRange, 20, 110)).toBe(20)
    })

    it('a non-zero-min range still lerps correctly (min need not be 0)', () => {
      // -> sqrt(4) = 2 = range.min: a node at the graph's OWN observed floor, not the global 0,
      //    still lands exactly on minRadius.
      const range = { min: 2, max: 4 }
      expect(lerpRadius(4, range, 20, 110)).toBe(20)
      expect(lerpRadius(16, range, 20, 110)).toBe(110)
      // -> sqrt(9) = 3, the midpoint of [2, 4] -> midpoint of [20, 110]
      expect(lerpRadius(9, range, 20, 110)).toBeCloseTo(65)
    })
  })
})
