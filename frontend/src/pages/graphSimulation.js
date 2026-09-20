import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { select } from 'd3-selection'
import { zoom as d3zoom } from 'd3-zoom'

import { nodeId } from './graphFilters.js'
import {
  LINK_CHILD_COUNT_CAP,
  LINK_CHILD_COUNT_SCALE,
  childCountTermFor,
  clusterForce,
  parentFanForce
} from './graphForces.js'

export { LINK_CHILD_COUNT_CAP, LINK_CHILD_COUNT_SCALE, childCountTermFor }

/**
 * Everything the page decides -- how a node is grouped, how large it draws, what colour its group
 * is -- comes in as a callback, so this file never reads the page's state.
 */

const LINK_BASE_DISTANCE = 40

export function childCountsFor(edges) {
  const counts = new Map()
  for (const edge of edges) {
    const key = typeof edge.source === 'string' ? edge.source : nodeId(edge.source)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Evaluated once at attach time, not per tick -- by then d3-force has resolved
 *  `link.source`/`link.target` from ids to the node objects `collideRadiusFor` needs. */
export function linkDistanceFor(link, collideRadiusFor, childCountFor = () => 0) {
  return (
    LINK_BASE_DISTANCE +
    collideRadiusFor(link.source) +
    collideRadiusFor(link.target) +
    childCountTermFor(childCountFor(link.source))
  )
}

const CHARGE_BASE_STRENGTH = 30
const CHARGE_RADIUS_FACTOR = 4

export function chargeStrengthFor(node, radiusFor) {
  return -(CHARGE_BASE_STRENGTH + radiusFor(node) * CHARGE_RADIUS_FACTOR)
}

/** `cluster` and `parentFan` are attached once and never re-attached on a `groupBy`/filter change:
 *  both recompute their own structure from the current tick. `0.05` keeps each a bias rather than
 *  the dominant force. */
export function startSimulation(
  nodes,
  edges,
  { width, height },
  { groupKeyFor, collideRadiusFor, radiusFor, onTick, clusterLevels = [1], childCountFor = () => 0 }
) {
  return forceSimulation(nodes)
    .force(
      'link',
      forceLink(edges)
        // -> Composite `${locale}:${path}` id, not bare `path`: two locales' translations of the
        //    same page share a `path` by design, and d3-force's `nodeById` map would otherwise
        //    collapse them onto whichever node it kept last. `graphFilters.js`'s edge builders key
        //    `source`/`target` on the same `nodeId()`, which keeps every edge resolvable.
        .id((d) => nodeId(d))
        .distance((link) => linkDistanceFor(link, collideRadiusFor, childCountFor))
    )
    .force(
      'charge',
      forceManyBody().strength((node) => chargeStrengthFor(node, radiusFor))
    )
    .force('collide', forceCollide(collideRadiusFor))
    .force('center', forceCenter(width / 2, height / 2))
    .force('cluster', clusterForce(groupKeyFor, 0.05, clusterLevels))
    .force('parentFan', parentFanForce(0.05))
    .on('tick', onTick)
}

// A visual starting point, not a derived value: a flat floor on top of the group's own `maxDist`,
// which already grows with each member's `radiusFor()`. Retune against a real graph.
const CLUSTER_PADDING = 24

/** Every group draws a circle, never a convex-hull polygon: a hull fits a spread-out group tighter,
 *  but per-group best-fit shapes read as visually inconsistent across a whole graph, so uniformity
 *  wins over fit.
 *
 *  `color` is resolved for level 1 only -- the categorical palette is an outermost-level concept;
 *  deeper entries stay `null` for the draw layer to fill with its shared neutral.
 *
 *  `parentGroupKeyFor` is asked for the key of the circle a synthetic (folder) node belongs to as a
 *  MEMBER -- its parent's -- never the key it would itself produce for its own children, which is
 *  what keeps a folder out of the circle it is itself the namer of. It applies at level 1 only, and
 *  omitting it excludes synthetic nodes from membership entirely. */
export function computeClusters(
  nodes,
  { groupKeyFor, colorForGroup, radiusFor, levels = [1], parentGroupKeyFor }
) {
  const result = []
  for (const level of levels) {
    const byGroup = new Map()
    for (const node of nodes) {
      if (node.x === undefined) {
        continue
      }
      if (node.synthetic) {
        if (level !== 1 || node.root || !parentGroupKeyFor) {
          continue
        }
        const key = parentGroupKeyFor(node)
        const list = byGroup.get(key) ?? []
        list.push(node)
        byGroup.set(key, list)
        continue
      }
      const key = groupKeyFor(node, level)
      if (key === null || key === undefined) {
        continue
      }
      const list = byGroup.get(key) ?? []
      list.push(node)
      byGroup.set(key, list)
    }

    for (const [key, groupNodes] of byGroup) {
      const color = level === 1 ? colorForGroup(key) : null
      const cx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length
      const cy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length
      // -> A `reduce`, not `Math.max(...groupNodes.map(...))`: the spread form blows V8's
      //    ~100-125k argument limit at large group sizes.
      const maxDist = groupNodes.reduce(
        (max, n) => Math.max(max, Math.hypot(n.x - cx, n.y - cy) + radiusFor(n)),
        0
      )
      result.push({ key, level, color, circle: { x: cx, y: cy, r: maxDist + CLUSTER_PADDING } })
    }
  }
  return result
}

// `scaleExtent` is a visual starting point: a readable single-node label at max zoom, the whole
// graph at min zoom on a typical viewport.
export function attachZoom(canvasEl, onZoom) {
  const selection = select(canvasEl)
  const behavior = d3zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      onZoom(event.transform)
    })
  selection.call(behavior)
}
