import { nodeId } from './graphFilters.js'

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

const QUARTER_TURN = Math.PI / 4
const FULL_TURN = Math.PI * 2
// -> Fallback distance from a parent when a node's own current radius from it is degenerate (0,
//    e.g. two nodes still sharing d3-force's origin-centered spiral start point on cold load).
//    Matches `graphSimulation.js`'s own `forceLink().distance(60)` starting point rather than
//    inventing a second unrelated constant.
const DEFAULT_RADIUS = 60

/**
 * Given a parent's own incoming angle (its angle from ITS OWN parent -- 0 for a parent with none,
 * i.e. the root, or a parent whose own parent isn't resolvable) plus one child's deterministic
 * sibling index/count, returns that child's target angle -- the exact stepping rule OpenProject
 * #2581's spec lays out:
 *
 * - 1 child: continues straight out at the parent's own incoming angle.
 * - 2 children: parent-angle ± 45°.
 * - 3 children: the same ± 45° pair, plus a third exactly at the parent's own angle (sibling index
 *   1 of 3, by construction below).
 * - 4+ children: full circle, evenly spaced at 360°/n, rotated so the parent's own incoming angle
 *   falls exactly at the midpoint between two adjacent children.
 *
 * The 3-vs-4+ jump (a ~90° wedge to a full 360° spread) is the spec's own deliberate discontinuity,
 * not a bug to smooth over.
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

/** A node's own parent-hierarchy id, derived the same way `graphFilters.js#buildPathHierarchyEdges`
 *  climbs `path` -- one directory segment up, composed with the node's own `locale` the same way
 *  every other id in this graph is (`nodeId()`). The root synthetic node (`root: true`, OpenProject
 *  #2563) has no parent of its own. */
function parentIdFor(node) {
  if (node.root) {
    return null
  }
  const idx = node.path.lastIndexOf('/')
  const parentPath = idx === -1 ? '' : node.path.slice(0, idx)
  return node.locale ? `${node.locale}:${parentPath}` : parentPath
}

/** The last `/`-separated segment of `path` -- the same basename `buildPathHierarchyEdges` derives
 *  a synthetic folder node's `title` from -- used here purely as the deterministic tie-break that
 *  keeps sibling ordering (and therefore each sibling's fan slot) stable across re-renders instead
 *  of reshuffling on every reload. `GraphNode` carries no separate `fileName` field to sort by. */
function basenameOf(path) {
  return path === '' ? '' : path.split('/').at(-1)
}

/**
 * A d3-force custom force implementing the "parent-relative fan" radial child placement (OpenProject
 * #2581, Task B of Feature #2579): each non-root node is nudged toward a target angle around its
 * own tree parent, computed relative to that parent's OWN incoming angle (its angle from ITS
 * parent), so a node's children wrap fully around it rather than all inheriting whatever single
 * direction the whole-graph charge/center forces happened to push that node in -- see the parent
 * Feature for the full "one-sided arc" problem this solves.
 *
 * Parent lookup and each node's sibling index/count are structural, not positional -- they follow
 * only from the tree shape (which `path`-hierarchy climbing already fixes), not from where anything
 * currently sits on canvas -- so they are computed once in `initialize(nodes)` rather than every
 * tick, the same "don't redo per-tick what only changes when the node/edge set does" split
 * `clusterForce` above draws between its own per-tick centroid recompute and this force's per-tick
 * trig nudge. d3-force calls every attached force's `initialize()` automatically whenever
 * `simulation.nodes(...)` is called (`Graph.vue`'s `syncSimulationToVisibleSet()` already does this
 * on every filter/edgeMode change), so this structure cache stays fresh with no `Graph.vue` changes
 * of its own.
 *
 * Deliberately reads only each node's own `path`/`locale`/`root` -- never the edge array -- to
 * derive "parent," mirroring `buildPathHierarchyEdges`'s own `parentOf()` climb rather than reading
 * `edgeMode: 'paths'` edges back off the simulation. This is also what keeps the force harmless
 * under a non-tree edge mode (`'tags'`/`'classification'`, still reachable until Task A/#2580 lands
 * and removes them): a real page's derived parent id there simply won't resolve against a node set
 * built from hub nodes rather than folder nodes, so `buildStructure()` below just finds no parent
 * for it and the force is a silent no-op on that node, never a crash.
 *
 * @param {number} strength - how strongly a node is nudged toward its target angle each tick,
 *   relative to the other forces in the simulation. `0.05` (this function's own default) matches
 *   `clusterForce`'s tuned starting point -- exploratory visual tuning happens once there's a real
 *   graph on screen, not here.
 */
export function parentFanForce(strength = 0.05) {
  // -> Map<node, { parent: node, grandparent: node|null, siblingIndex: number, siblingCount: number }>
  //    Rebuilt wholesale on every `initialize()` call rather than diffed -- cheap at this graph's
  //    confirmed real-world scale (low hundreds to low thousands of nodes), matching the same
  //    "always rebuild rather than track incremental deltas" call `buildPathHierarchyEdges` already
  //    makes for the structurally-identical climb.
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
        // -> This node's derived parent id doesn't exist in the current node set (e.g. a non-tree
        //    edge mode with no folder-hierarchy synthetic nodes at all) -- leave every child in this
        //    group out of `structure`, so `force()` below simply skips them.
        continue
      }
      const grandparent = resolveParent(parent)
      const sorted = [...children].sort((a, b) =>
        basenameOf(a.path).localeCompare(basenameOf(b.path))
      )
      sorted.forEach((child, siblingIndex) => {
        next.set(child, { parent, grandparent, siblingIndex, siblingCount: sorted.length })
      })
    }
    structure = next
  }

  function force(alpha) {
    for (const [node, { parent, grandparent, siblingIndex, siblingCount }] of structure) {
      if (node.x === undefined || parent.x === undefined) {
        continue
      }
      const parentAngle =
        grandparent && grandparent.x !== undefined
          ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x)
          : 0
      const targetAngle = targetAngleFor(parentAngle, siblingIndex, siblingCount)
      const radius = Math.hypot(node.x - parent.x, node.y - parent.y) || DEFAULT_RADIUS
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
