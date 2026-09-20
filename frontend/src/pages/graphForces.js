import { nodeId } from './graphFilters.js'

/**
 * A custom force rather than a `forceX`/`forceY` pair, because those evaluate their target accessor
 * exactly once at initialize time and cache it. Clustering forces are attached before the first
 * tick, when every node still sits in d3's phyllotaxis spiral around the origin, so the cached
 * targets pin every node toward the canvas's top-left corner forever -- a degenerate NW-pointing
 * fan on cold load. Recomputing centroids inside the per-tick call is what makes this a genuine
 * running centroid.
 *
 * @param {(node: object, level?: number) => string | null | undefined} groupKeyFor - a
 *   `null`/`undefined` key for a node+level excludes that node from that level's pull entirely.
 * @param {number} strength - applied per level rather than split across them, so a node belonging
 *   to several levels' groups is pulled toward each centroid cumulatively.
 * @param {number[]} levels - nesting levels to pull toward; `[1, 2, 3]` for nested folder mode.
 * @returns {(alpha: number) => void} a d3-force-compatible force, with the `initialize(nodes)`
 *   method d3 calls when it is attached.
 */
export function clusterForce(groupKeyFor, strength = 0.05, levels = [1]) {
  let nodes = []

  function force(alpha) {
    for (const level of levels) {
      const sums = new Map()
      for (const node of nodes) {
        if (node.synthetic || node.x === undefined) {
          continue
        }
        const key = groupKeyFor(node, level)
        if (key === null || key === undefined) {
          continue
        }
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
        const key = groupKeyFor(node, level)
        if (key === null || key === undefined) {
          continue
        }
        const centroid = centroids.get(key)
        if (!centroid) {
          continue
        }
        node.vx += (centroid.x - node.x) * strength * alpha
        node.vy += (centroid.y - node.y) * strength * alpha
      }
    }
  }

  force.initialize = (_nodes) => {
    nodes = _nodes
  }

  return force
}

const QUARTER_TURN = Math.PI / 4
const FULL_TURN = Math.PI * 2
// -> Fallback when a node's current radius from its parent is degenerate (two nodes still sharing
//    d3-force's origin-centered spiral start point on cold load), which has no usable direction.
const DEFAULT_RADIUS = 60

// -> Past this many children a parent's fan splits across concentric rings instead of subdividing
//    one ring's angle step ever more finely. A starting point, not a verified-correct constant:
//    exploratory visual tuning belongs against a real, populated graph.
const RING_CHILD_CAPACITY = 6

// -> How far outward each additional ring pushes its children's target radius. Comfortably past
//    `DEFAULT_RADIUS` so a second ring separates visually rather than overlapping the first,
//    without dominating the link/charge forces' own say over radius. Also a starting point.
const RING_RADIUS_STEP = 80

/**
 * Ring sizes differ by at most 1, so a count just past the threshold produces two comparable rings
 * rather than one full ring plus a nearly-empty second.
 *
 * @returns {number[]} one entry per ring, each ring's child count, summing to `count`.
 */
function assignRingSizes(count) {
  if (count <= RING_CHILD_CAPACITY) {
    return [count]
  }
  const ringCount = Math.ceil(count / RING_CHILD_CAPACITY)
  const base = Math.floor(count / ringCount)
  const remainder = count % ringCount
  return Array.from({ length: ringCount }, (_, ringIndex) => base + (ringIndex < remainder ? 1 : 0))
}

/**
 * `parentAngle` is the parent's angle from ITS own parent, `0` when it has none. Up to 3 children
 * fan within a ±45° wedge of it; 4 or more spread over a full circle, the half-step rotation
 * putting `parentAngle` exactly midway between two adjacent children rather than on one of them.
 * The 3-to-4 jump from a 90° wedge to a full 360° spread is deliberate, not a bug to smooth over.
 */
function targetAngleFor(parentAngle, siblingIndex, siblingCount) {
  if (siblingCount <= 1) {
    return parentAngle
  }
  if (siblingCount === 2) {
    return parentAngle + (siblingIndex === 0 ? -QUARTER_TURN : QUARTER_TURN)
  }
  if (siblingCount === 3) {
    return parentAngle + (siblingIndex - 1) * QUARTER_TURN
  }
  const step = FULL_TURN / siblingCount
  return parentAngle + step / 2 + siblingIndex * step
}

/** Mirrors `graphFilters.js#buildPathHierarchyEdges`'s own climb -- one directory segment up,
 *  locale-qualified -- so the fan's tree and the rendered tree cannot disagree. */
function parentIdFor(node) {
  if (node.root) {
    return null
  }
  const idx = node.path.lastIndexOf('/')
  const parentPath = idx === -1 ? '' : node.path.slice(0, idx)
  return node.locale ? `${node.locale}:${parentPath}` : parentPath
}

/** The deterministic sort key behind sibling ordering, so each sibling keeps its fan slot across
 *  re-renders instead of reshuffling. A node carries no separate filename field to sort by. */
function basenameOf(path) {
  return path === '' ? '' : path.split('/').at(-1)
}

/**
 * Fans each non-root node around its tree parent at an angle measured from that parent's OWN
 * incoming angle, so children wrap fully around it instead of all inheriting whichever single
 * direction the charge/center forces happened to push the parent in -- the one-sided-arc problem.
 *
 * Parent lookup and sibling index/count are structural, not positional, so they are computed in
 * `initialize(nodes)` rather than every tick. d3-force calls `initialize()` whenever
 * `simulation.nodes(...)` is set, which keeps the cache fresh with no work at the call site.
 *
 * Parentage is derived only from a node's own `path`/`locale`/`root`, never from the edge array.
 * That also keeps this harmless under a non-tree edge mode: a derived parent id simply fails to
 * resolve against a hub-node set, so the force is a silent no-op there rather than a crash.
 */
export function parentFanForce(strength = 0.05) {
  // -> Map<node, { parent: node, grandparent: node|null, ringIndex: number, siblingIndex: number,
  //    siblingCount: number }>. `siblingIndex`/`siblingCount` are scoped to the node's own ring,
  //    not the parent's whole child count. Rebuilt wholesale rather than diffed -- cheap at this
  //    graph's real-world scale of low hundreds to low thousands of nodes.
  let structure = new Map()

  function buildStructure(nodes) {
    const byId = new Map()
    for (const node of nodes) {
      byId.set(nodeId(node), node)
    }

    function resolveParent(node) {
      const parentId = parentIdFor(node)
      return parentId === null ? null : (byId.get(parentId) ?? null)
    }

    const childrenByParentId = new Map()
    for (const node of nodes) {
      if (node.root) {
        continue
      }
      const parentId = parentIdFor(node)
      const list = childrenByParentId.get(parentId) ?? []
      list.push(node)
      childrenByParentId.set(parentId, list)
    }

    const next = new Map()
    for (const [parentId, children] of childrenByParentId) {
      const parent = byId.get(parentId)
      if (!parent) {
        // -> Derived parent absent from the current node set (a non-tree edge mode has no
        //    folder-hierarchy nodes at all): leave the whole group out, so `force()` skips them.
        continue
      }
      const grandparent = resolveParent(parent)
      const sorted = [...children].sort((a, b) =>
        basenameOf(a.path).localeCompare(basenameOf(b.path))
      )
      // -> Re-indexed per ring, so each ring gets the same stepping rule scoped to its own count.
      const ringSizes = assignRingSizes(sorted.length)
      let cursor = 0
      ringSizes.forEach((ringSize, ringIndex) => {
        for (let siblingIndex = 0; siblingIndex < ringSize; siblingIndex++) {
          next.set(sorted[cursor], {
            parent,
            grandparent,
            ringIndex,
            siblingIndex,
            siblingCount: ringSize
          })
          cursor++
        }
      })
    }
    structure = next
  }

  function force(alpha) {
    for (const [
      node,
      { parent, grandparent, ringIndex, siblingIndex, siblingCount }
    ] of structure) {
      if (node.x === undefined || parent.x === undefined) {
        continue
      }
      const parentAngle =
        grandparent && grandparent.x !== undefined
          ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x)
          : 0
      const targetAngle = targetAngleFor(parentAngle, siblingIndex, siblingCount)
      // -> Ring 0 leaves the node's current radius alone; each further ring pushes outward, so
      //    rings separate instead of stacking on one circle.
      const baseRadius = Math.hypot(node.x - parent.x, node.y - parent.y) || DEFAULT_RADIUS
      const radius = baseRadius + ringIndex * RING_RADIUS_STEP
      const targetX = parent.x + radius * Math.cos(targetAngle)
      const targetY = parent.y + radius * Math.sin(targetAngle)
      node.vx += (targetX - node.x) * strength * alpha
      node.vy += (targetY - node.y) * strength * alpha
    }
  }

  force.initialize = (_nodes) => {
    buildStructure(_nodes)
  }

  return force
}

/** Deliberately NOT scaled by distance: the intent is a subtle "make room" pulse, not an explosion
 *  whose nearest neighbours fly the farthest. */
const HOVER_PUSH_STRENGTH = 4

/**
 * A one-off velocity mutation per hover-target change, not a d3-force force attached to the
 * simulation. The caller must follow it with `simulation.alpha(...).restart()`, which is what lets
 * the existing forces settle the nudged nodes again; this only supplies the kick. `hoveredNode` is
 * matched by reference, so it must be the very object from `nodes`.
 */
export function applyHoverPushImpulse(nodes, hoveredNode, strength = HOVER_PUSH_STRENGTH) {
  if (!hoveredNode || hoveredNode.x === undefined) {
    return
  }
  for (const node of nodes) {
    if (node === hoveredNode || node.x === undefined) {
      continue
    }
    const dx = node.x - hoveredNode.x
    const dy = node.y - hoveredNode.y
    const dist = Math.hypot(dx, dy)
    // -> Coincident nodes have no defined direction to push apart along; an arbitrary fixed one is
    //    as good as any other and, unlike skipping the node, still moves it.
    const [ux, uy] = dist > 0 ? [dx / dist, dy / dist] : [1, 0]
    node.vx += ux * strength
    node.vy += uy * strength
  }
}
