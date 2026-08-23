/**
 * A d3-force custom force implementing a genuine per-tick running centroid (OpenProject #1158),
 * replacing the `forceX`/`forceY` pair `Graph.vue` used to attach for cluster grouping.
 *
 * `forceX`/`forceY` evaluate their target accessor exactly once, at force-initialize time, and cache
 * the result (d3-force 3.0.0, `src/x.js`) -- they never re-read it on later ticks. `Graph.vue`
 * attaches its clustering force before the simulation's first tick, when every node still sits in
 * d3's deterministic phyllotaxis spiral around `(0, 0)`, so every group's centroid at that instant is
 * itself near the origin -- the cached targets pin every real node toward the canvas's top-left
 * corner forever, producing a degenerate NW-pointing fan of edges on cold load (root-caused and
 * measured in OpenProject #1158; see that WP for the full writeup).
 *
 * A custom force sidesteps the caching entirely: d3-force calls the returned function once per tick
 * with the current alpha, so recomputing group centroids from each node's *current* `x`/`y` inside
 * that call is what makes this the "running centroid" `Graph.vue`'s doc comment already promised.
 *
 * @param {(node: object) => string} groupKeyFor - the same grouping-dimension accessor `Graph.vue`
 *   uses for coloring/legend/hulls (folder, tag, or classification) -- passed in rather than
 *   hardcoded so this module stays decoupled from `Graph.vue` and unit-testable on its own.
 * @param {number} strength - how strongly a node is nudged toward its group's centroid each tick,
 *   relative to the other forces in the simulation. `0.05` is `Graph.vue`'s tuned starting point.
 * @returns {(alpha: number) => void} a d3-force-compatible force: has an `initialize(nodes)` method
 *   (called automatically when attached via `simulation.force(name, force)`) and is itself callable
 *   with the tick's `alpha`.
 */
export function clusterForce(groupKeyFor, strength = 0.05) {
  let nodes = []

  function force(alpha) {
    const sums = new Map()
    for (const node of nodes) {
      if (node.synthetic || node.x === undefined) {
        continue
      }
      const key = groupKeyFor(node)
      const entry = sums.get(key) ?? { x: 0, y: 0, count: 0 }
      entry.x += node.x
      entry.y += node.y
      entry.count += 1
      sums.set(key, entry)
    }

    const centroids = new Map()
    for (const [key, { x, y, count }] of sums) {
      centroids.set(key, { x: x / count, y: y / count })
    }

    for (const node of nodes) {
      if (node.synthetic || node.x === undefined) {
        continue
      }
      const centroid = centroids.get(groupKeyFor(node))
      if (!centroid) {
        continue
      }
      node.vx += (centroid.x - node.x) * strength * alpha
      node.vy += (centroid.y - node.y) * strength * alpha
    }
  }

  force.initialize = (_nodes) => {
    nodes = _nodes
  }

  return force
}
