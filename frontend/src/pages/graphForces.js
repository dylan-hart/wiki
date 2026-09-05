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

// -> OpenProject #2582 (Task C): past this many children, a parent's fan stops subdividing one
//    ring's angle step ever more finely and instead splits its children across a second (and
//    further) concentric ring -- see `assignRingSizes()` below. A starting point, not a verified-
//    correct constant, per this file's own convention (see `graphSimulation.js`'s doc comments):
//    picked so the WP's own motivating case -- 7 children already reading as crowded on a single
//    ring (the `beetle` node screenshot) -- is the first count past it, not still under it.
//    Exploratory visual tuning happens once there's a real, populated graph on screen.
const RING_CHILD_CAPACITY = 6

// -> How far outward (in the same px units as everything else in this force) each additional ring
//    pushes its children's target radius, on top of the node's own current radius from the parent
//    -- see the `radius` computation in `force()` below. `80` is a starting point: comfortably past
//    `DEFAULT_RADIUS`'s 60px fallback so a second ring visually separates from the first rather than
//    overlapping it, without being so large it dominates the link/charge forces' own say over radius.
//    Same "starting point, tune visually" status as `RING_CHILD_CAPACITY` above.
const RING_RADIUS_STEP = 80

/**
 * Splits `count` children into one or more concentric-ring "buckets," each no larger than
 * `RING_CHILD_CAPACITY`, with sizes differing by at most 1 -- so a count just past the threshold
 * (e.g. `RING_CHILD_CAPACITY + 1`) produces two comparably-sized rings rather than one full ring
 * plus a nearly-empty second one. `count <= RING_CHILD_CAPACITY` returns a single bucket of the
 * whole count, which is what keeps a parent at or under the threshold's behavior identical to
 * OpenProject #2581's original single-ring fan (ring index 0 everywhere, no radius offset).
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
  // -> The first `remainder` rings absorb one extra child each, so every ring's size is `base` or
  //    `base + 1` -- never a lone outlier ring far smaller than its siblings.
  return Array.from({ length: ringCount }, (_, ringIndex) => base + (ringIndex < remainder ? 1 : 0))
}

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
 * OpenProject #2582 (Task C): once a parent's child count exceeds `RING_CHILD_CAPACITY`, its
 * children no longer all share one ring's ever-finer angle subdivision -- they split across evenly
 * sized concentric rings (`assignRingSizes()` above), each independently getting the same 1/2/3/4+
 * `targetAngleFor()` stepping rule scoped to that ring's own child count, and each ring beyond the
 * first pushed an extra `RING_RADIUS_STEP` px outward (see `force()` below). A parent at or under
 * the threshold gets exactly one ring holding every child, which is why this is a strict superset of
 * #2581's original behavior rather than a parallel code path.
 *
 * @param {number} strength - how strongly a node is nudged toward its target angle each tick,
 *   relative to the other forces in the simulation. `0.05` (this function's own default) matches
 *   `clusterForce`'s tuned starting point -- exploratory visual tuning happens once there's a real
 *   graph on screen, not here.
 */
export function parentFanForce(strength = 0.05) {
  // -> Map<node, { parent: node, grandparent: node|null, ringIndex: number, siblingIndex: number,
  //    siblingCount: number }> -- `siblingIndex`/`siblingCount` are scoped to the node's own ring
  //    (its position and count *within that ring*), not the parent's whole child count; `ringIndex`
  //    is what `force()` below folds into the target radius. Rebuilt wholesale on every
  //    `initialize()` call rather than diffed -- cheap at this graph's confirmed real-world scale
  //    (low hundreds to low thousands of nodes), matching the same "always rebuild rather than track
  //    incremental deltas" call `buildPathHierarchyEdges` already makes for the structurally-
  //    identical climb.
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
      // -> Split `sorted` across one or more rings (a single ring holding everyone when the count
      //    is at or under the threshold), then re-index each child by its position *within its own
      //    ring* -- `targetAngleFor()` below is fed that within-ring index/count, so each ring
      //    independently gets the same 1/2/3/4+ stepping rule scoped to its own child count.
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
      // -> Ring 0 keeps the node's own current radius unchanged (byte-for-byte #2581 behavior);
      //    each ring beyond it additionally pushes the target outward by `RING_RADIUS_STEP` per
      //    ring, so rings visually separate instead of stacking on the same circle.
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
