import { describe, expect, it } from 'vitest'

import { lerpRadius, sqrtRangeOf } from './graphNodeSize.js'

/*
 * The pure min/max lerp math behind a node's drawn radius (OpenProject #2561), tested free of
 * `Graph.vue`/Vue/d3 -- `Graph.vue`'s own `radiusFor()` is covered end-to-end through
 * `Graph.sizing.test.js` and `Graph.layout.test.js`; this suite is the range-tracking and
 * interpolation math those rely on.
 *
 * `lerpRadius` takes its bounds as parameters, so nothing here would break if `Graph.vue`'s
 * constants moved -- but every case below still passes the real `MIN_NODE_RADIUS`/`MAX_NODE_RADIUS`
 * pair (`10`/`110`, the floor doubled from `5` by OpenProject #2594) rather than arbitrary numbers,
 * so the arithmetic in these comments describes radii the app actually draws.
 */
describe('graphNodeSize', () => {
  describe('sqrtRangeOf', () => {
    it('returns the sqrt-space min/max across the given counts', () => {
      // -> sqrt(0) = 0, sqrt(100) = 10, sqrt(25) = 5 -- min/max picked out of sqrt space, not the
      //    raw counts (a raw-space min/max would still coincidentally read 0/10 here; the next
      //    test is what actually distinguishes the two spaces).
      expect(sqrtRangeOf([0, 100, 25])).toEqual({ min: 0, max: 10 })
    })

    it('orders by the SQUARE ROOT, not the raw count -- proving this is sqrt space, not raw space', () => {
      // -> Raw counts 4 and 9 have sqrt 2 and 3 -- same order either space would give. Flip in the
      //    array 16 and 1: sqrt(16) = 4, sqrt(1) = 1, so if this function operated in raw space by
      //    mistake it would still report min 1 / max 16, not min 1 / max 4.
      expect(sqrtRangeOf([16, 1])).toEqual({ min: 1, max: 4 })
    })

    it('collapses a degenerate all-same-count list to a zero-width range AT that count’s own sqrt, not at 0', () => {
      // -> A zero-width range (min === max), but at sqrt(7), not artificially reset to 0 -- there is
      //    nothing to rank against either way, which is `lerpRadius()`'s concern (its own test below
      //    covers the zero-width-range floor), not this function's.
      const range = sqrtRangeOf([7, 7, 7])
      expect(range.min).toBe(range.max)
      expect(range.min).toBeCloseTo(Math.sqrt(7))
    })

    it('collapses an empty list (no real nodes loaded) to a zero-width range specifically at 0', () => {
      // -> The one case that genuinely has no count to reflect, unlike the all-same-count case
      //    above -- this is the only path that produces exactly {min: 0, max: 0}.
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
      expect(lerpRadius(0, range, 10, 110)).toBe(10)
      // -> count 100 -> sqrt(100) = 10 = range.max
      expect(lerpRadius(100, range, 10, 110)).toBe(110)
    })

    it('interpolates linearly BETWEEN the two, in sqrt space', () => {
      const range = { min: 0, max: 10 }
      // -> count 25 -> sqrt(25) = 5, the exact midpoint of [0, 10] -> exact midpoint of [10, 110]
      expect(lerpRadius(25, range, 10, 110)).toBeCloseTo(60)
    })

    it('never divides by zero on a zero-width range, drawing at the floor instead', () => {
      const zeroWidthRange = { min: 0, max: 0 }
      expect(lerpRadius(0, zeroWidthRange, 10, 110)).toBe(10)
      // -> Same floor even for a non-zero shared count -- the range came from sqrtRangeOf() folding
      //    every loaded node's identical count down to {min: 0, max: 0} regardless of what that
      //    shared count actually was, so a node's OWN count plays no role once the range is
      //    zero-width -- only the range shape decides.
      expect(lerpRadius(999, zeroWidthRange, 10, 110)).toBe(10)
    })

    it('a non-zero-min range still lerps correctly (min need not be 0)', () => {
      // -> sqrt(4) = 2 = range.min, sqrt(16) = 4 = range.max -- a node right at the graph's own
      //    observed floor (not the global floor of 0) still lands exactly at minRadius.
      const range = { min: 2, max: 4 }
      expect(lerpRadius(4, range, 10, 110)).toBe(10)
      expect(lerpRadius(16, range, 10, 110)).toBe(110)
      // -> sqrt(9) = 3, the midpoint of [2, 4] -> midpoint of [10, 110]
      expect(lerpRadius(9, range, 10, 110)).toBeCloseTo(60)
    })
  })
})
