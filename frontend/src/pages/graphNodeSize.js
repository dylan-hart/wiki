/**
 * Pure min/max lerp math behind a node's drawn radius (OpenProject #2561) -- kept free of Vue/d3 so
 * it's testable as plain functions, the same reason `graphFilters.js`/`graphForces.js` sit apart
 * from `Graph.vue`. `Graph.vue` owns `MIN_NODE_RADIUS`/`MAX_NODE_RADIUS` and the two per-node
 * counters (`contributorCountFor`/`pageviewCountFor`) that feed this; this module only tracks the
 * current graph's own observed range and interpolates within it.
 */

/** The sqrt-space `[min, max]` across `counts` -- every REAL node's count for the currently active
 *  sizing metric. Interpolating in sqrt space (not the raw count) is what makes a node's drawn AREA
 *  read as proportional to its count (OpenProject #1141), the standard convention for encoding a
 *  magnitude in a circle's size -- linear radius scaling would make a 4x-more-contributed page look
 *  ~16x more prominent by area, overwhelming the rest of the graph. A degenerate `counts` where every
 *  entry is identical still returns its true (zero-width) sqrt-space range, at that shared value's
 *  own sqrt -- not artificially reset to `0` -- since `lerpRadius()` below only needs the range's
 *  WIDTH to detect the divide-by-zero case, not its position. An empty `counts` (no real nodes loaded
 *  at all -- nothing to take a min/max of in the first place) is the one genuine `{min: 0, max: 0}`
 *  case, since `Math.min`/`Math.max` over nothing has no better answer to fall back to. */
export function sqrtRangeOf(counts) {
  let min = Infinity
  let max = -Infinity
  for (const count of counts) {
    const root = Math.sqrt(count)
    if (root < min) {
      min = root
    }
    if (root > max) {
      max = root
    }
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 }
}

/** One count's drawn radius: linearly interpolated between `minRadius` and `maxRadius` by where
 *  `Math.sqrt(count)` falls within `range` (from `sqrtRangeOf()`) -- so a node's size expresses its
 *  RANK within the current graph's own observed range for this metric, not a fixed absolute scale.
 *  A zero-width `range` (`range.max === range.min`, whether from the degenerate all-loaded-nodes-
 *  share-one-count case or the no-real-nodes-loaded case `sqrtRangeOf()` folds into the same shape)
 *  would otherwise divide by zero; that case draws at the floor (`minRadius`) instead, matching the
 *  pre-lerp formula's own zero-count floor. */
export function lerpRadius(count, range, minRadius, maxRadius) {
  const span = range.max - range.min
  const t = span > 0 ? (Math.sqrt(count) - range.min) / span : 0
  return minRadius + t * (maxRadius - minRadius)
}
