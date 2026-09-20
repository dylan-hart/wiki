/** Sqrt space, not raw counts, so a node's drawn AREA reads as proportional to its count -- the
 *  standard convention for encoding a magnitude in a circle. Scaling the radius linearly instead
 *  would make a 4x-more-contributed page look 16x more prominent, overwhelming the graph.
 *
 *  A `counts` whose entries are all identical keeps its true zero-width range at that value's own
 *  sqrt rather than collapsing to `0`; only an empty `counts` genuinely has no answer. */
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

/** Interpolating within `range` means a node's size expresses its RANK in the current graph's own
 *  observed range for the metric, never a fixed absolute scale. A zero-width range would divide by
 *  zero, so it draws at the floor instead. */
export function lerpRadius(count, range, minRadius, maxRadius) {
  const span = range.max - range.min
  const t = span > 0 ? (Math.sqrt(count) - range.min) / span : 0
  return minRadius + t * (maxRadius - minRadius)
}
