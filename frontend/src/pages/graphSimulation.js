import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { polygonHull } from 'd3-polygon'
import { select } from 'd3-selection'
import { zoom as d3zoom } from 'd3-zoom'

import { nodeId } from './graphFilters.js'
import { clusterForce, parentFanForce } from './graphForces.js'

/**
 * `Graph.vue`'s layout half: the d3-force simulation, the group hulls drawn around its result, and
 * the zoom behaviour attached to the canvas.
 *
 * Kept apart from `graphDraw.js`, which only paints what these produce. Everything the page decides
 * -- how a node is grouped, how large it draws, what colour its group is -- comes in as a callback
 * rather than being recomputed here, so this file never reads the page's state.
 */

/*
  `forceLink().id()` resolves against each node's composite `${locale}:${path}` id (OpenProject
  #1621/#1629), not the bare `path` -- translations share a path by design
  (`docs/decisions/locale-translation-linking.md`), so an `id`-of-`path` accessor would make
  d3-force's `nodeById` map collapse an `en`/`fr` pair sharing a path down to whichever one it
  processed last, with no error. `node.path` stays around on every node (real and synthetic alike)
  as the display/navigation field -- `onCanvasClick`, the hover tooltip and `drawLabels()` all still
  read it.

  `d3.forceLink`'s distance (60) and `d3.forceManyBody`'s charge strength (-120) are starting
  points, not verified-correct constants -- exploratory visual tuning happens once there's a real
  graph on screen (Task 13, #888), not here. `forceCollide`'s radius (`collideRadiusFor`, OpenProject
  #1141) is sized off a plausible node-dot radius, same caveat.

  The `cluster` force (`graphForces.js#clusterForce`, OpenProject #1158) pulls each node toward a
  running centroid of its own group, layered on top of the forces above -- those alone don't
  produce visually coherent clusters (per the spec). `0.05` is a starting point: low enough that
  the other forces still dominate local layout, this is meant to be a bias toward clustering, not
  the dominant force -- tune visually once there's a real graph on screen. It is attached once,
  here, rather than re-attached on every `groupBy` change: unlike the `forceX`/`forceY` pair it
  replaced (which cached their target at force-initialize time -- the root cause of #1158's frozen-
  origin bug), this force recomputes group centroids from the *current* tick's `x`/`y` every time
  d3-force calls it, so a `groupBy` change needs no re-attachment to take effect on the next tick.

  The `parentFan` force (`graphForces.js#parentFanForce`, OpenProject #2581) is the same kind of
  always-on, small-weight custom force -- layered on top of everything above, replacing none of it.
  It nudges each non-root node toward a target angle around its own tree parent (derived from the
  node's own `path`/`locale`, not from `edges`), which is what turns the one-sided arc the parent
  Feature (#2579) describes into children wrapping fully around their parent. Attached once here for
  the same reason `cluster` is: it recomputes its own parent/sibling structure from the current node
  set every time d3-force re-initializes it (i.e. every `simulation.nodes(...)` call), so a filter or
  `edgeMode` change needs no re-attachment either.
*/
export function startSimulation(
  nodes,
  edges,
  { width, height },
  { groupKeyFor, collideRadiusFor, onTick }
) {
  return forceSimulation(nodes)
    .force(
      'link',
      forceLink(edges)
        // -> Composite `${locale}:${path}` id (OpenProject #1621/#1629), not bare `path`: two locales'
        //    translations of the same page share a `path` by design, and d3-force's `nodeById`
        //    map (built from this accessor) would otherwise collapse them onto whichever node it
        //    kept last -- N duplicate dots on top of each other, every edge attached to just one
        //    of them. `graphFilters.js`'s edge builders key their `source`/`target` on the same
        //    `nodeId()` helper, which is what keeps this accessor's output resolvable against
        //    every edge actually fed into the `edges` this is handed.
        .id((d) => nodeId(d))
        .distance(60)
    )
    .force('charge', forceManyBody().strength(-120))
    .force('collide', forceCollide(collideRadiusFor))
    .force('center', forceCenter(width / 2, height / 2))
    .force('cluster', clusterForce(groupKeyFor, 0.05))
    .force('parentFan', parentFanForce(0.05))
    .on('tick', onTick)
}

/*
  `16`px is a starting point sized against the `5`px node-dot radius in `drawNodes()` -- tune
  visually so the hull clearly contains the dots without ballooning past neighboring clusters. It's
  a floor added on top of each node's own `radiusFor()` (OpenProject #2296), not the whole gap any
  more -- see `padHull()` and `computeClusters()`'s circle case below, both of which used to pad by
  this constant alone and let a large node (up to `MAX_NODE_RADIUS`, `110` as of OpenProject #2561's
  min/max lerp rework -- one shared ceiling for both sizing metrics, was `22`) poke through its own
  group tint.
*/
const HULL_PADDING = 16
/** Pads a hull outward from its own centroid so the fill visually contains the node dots rather
 *  than passing through their centers, per the spec's "Obsidian-style" sector requirement. Each
 *  `point` is a `[x, y, node]` triple (see `computeClusters()`) so the offset can grow by that
 *  vertex's own `radiusFor(node)` on top of the flat `padding` (OpenProject #2296) -- a large node
 *  sitting on the hull boundary would otherwise poke through the tint by the difference between its
 *  drawn radius and the flat padding. `polygonHull` (`d3-polygon`) returns references to the exact
 *  input elements it hulled, so the third element survives intact into `points` here. */
function padHull(points, padding, radiusFor) {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length
  return points.map(([x, y, node]) => {
    const dx = x - cx
    const dy = y - cy
    const len = Math.hypot(dx, dy) || 1
    const vertexPadding = padding + (node ? radiusFor(node) : 0)
    return [x + (dx / len) * vertexPadding, y + (dy / len) * vertexPadding]
  })
}

/** Populates `clusters.value` -- one entry per visible group with `hullPoints` (>=3 nodes) or a
 *  fallback `circle` (1-2 nodes, or a degenerate >=3-node group `polygonHull` can't hull, e.g.
 *  every point collinear). Both shapes are sized off each node's edge (its centre plus its own
 *  `radiusFor()`), not just its centre (OpenProject #2296) -- `collideRadiusFor()` above already
 *  adds `radiusFor(node)` to a constant the same way, and is the pattern this mirrors. */
export function computeClusters(nodes, { groupKeyFor, colorForGroup, radiusFor }) {
  const byGroup = new Map()
  for (const node of nodes) {
    if (node.x === undefined || node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    const list = byGroup.get(key) ?? []
    list.push(node)
    byGroup.set(key, list)
  }

  const result = []
  for (const [key, groupNodes] of byGroup) {
    const color = colorForGroup(key)
    if (groupNodes.length >= 3) {
      const hull = polygonHull(groupNodes.map((n) => [n.x, n.y, n]))
      if (hull) {
        result.push({ key, color, hullPoints: padHull(hull, HULL_PADDING, radiusFor) })
        continue
      }
      // -> `polygonHull` returns null for degenerate input (e.g. every point collinear) even with
      //    >=3 nodes; fall through to the circle case below rather than drawing nothing.
    }
    const cx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length
    const cy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length
    // -> A `reduce`, not `Math.max(...groupNodes.map(...))` -- the spread form blows V8's ~100-125k
    //    argument limit at large group sizes (OpenProject #1837, a latent hazard only; no group has
    //    come close to that in practice). Sized off each node's edge (its centre plus its own
    //    `radiusFor()`), not just its centre (OpenProject #2296) -- see the `computeClusters()` doc
    //    comment above.
    const maxDist = groupNodes.reduce(
      (max, n) => Math.max(max, Math.hypot(n.x - cx, n.y - cy) + radiusFor(n)),
      0
    )
    result.push({ key, color, circle: { x: cx, y: cy, r: maxDist + HULL_PADDING } })
  }
  return result
}

/*
  `scaleExtent([0.1, 8])` is a starting point (wide enough to read a single node's label at max
  zoom and see the whole graph at min zoom on a typical viewport) -- tune visually once there's
  real data to zoom around in.
*/
export function attachZoom(canvasEl, onZoom) {
  const selection = select(canvasEl)
  const behavior = d3zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      onZoom(event.transform)
    })
  selection.call(behavior)
}
