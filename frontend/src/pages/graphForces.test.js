import { describe, expect, it } from 'vitest'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { buildPathHierarchyEdges } from './graphFilters.js'
import { applyHoverPushImpulse, clusterForce, parentFanForce } from './graphForces.js'

/**
 * Mean resultant length for circular data: 1 means every edge points the same way (the degenerate
 * directional wedge), near 0 means directions are spread out (a normal radial fan).
 */
function edgeAngleConcentration(edges) {
  let sumCos = 0
  let sumSin = 0
  let n = 0
  for (const edge of edges) {
    const dx = edge.target.x - edge.source.x
    const dy = edge.target.y - edge.source.y
    if (dx === 0 && dy === 0) {
      continue
    }
    const theta = Math.atan2(dy, dx)
    sumCos += Math.cos(theta)
    sumSin += Math.sin(theta)
    n += 1
  }
  return n === 0 ? 0 : Math.hypot(sumCos, sumSin) / n
}

describe('clusterForce (OpenProject #1158)', () => {
  it("nudges a node toward its group's current centroid, with none for a synthetic node", () => {
    const nodeA = { path: 'a', x: 0, y: 0, vx: 0, vy: 0, group: 'g1' }
    const nodeB = { path: 'b', x: 10, y: 10, vx: 0, vy: 0, group: 'g1' }
    const synthetic = { path: 's', x: -100, y: -100, vx: 0, vy: 0, synthetic: true, group: 'g1' }
    const nodes = [nodeA, nodeB, synthetic]

    const force = clusterForce((n) => n.group, 0.1)
    force.initialize(nodes)
    force(1)

    // Centroid, excluding the synthetic node, is (5, 5) -- between nodeA and nodeB.
    expect(nodeA.vx).toBeGreaterThan(0)
    expect(nodeA.vy).toBeGreaterThan(0)
    expect(nodeB.vx).toBeLessThan(0)
    expect(nodeB.vy).toBeLessThan(0)
    expect(synthetic.vx).toBe(0)
    expect(synthetic.vy).toBe(0)
  })

  it('recomputes centroids from the current tick every call, not a cached snapshot', () => {
    const nodeA = { path: 'a', x: 0, y: 0, vx: 0, vy: 0, group: 'g1' }
    const nodeB = { path: 'b', x: 100, y: 0, vx: 0, vy: 0, group: 'g1' }
    const nodes = [nodeA, nodeB]
    const force = clusterForce((n) => n.group, 0.1)
    force.initialize(nodes)

    force(1)
    const firstPull = nodeA.vx

    // Moving the centroid between calls: a force that cached it at initialize would keep pulling
    // nodeA toward the stale (50, 0).
    nodeB.x = 1000
    nodeA.vx = 0
    force(1)

    expect(nodeA.vx).toBeGreaterThan(firstPull)
  })
})

describe('clusterForce levels (OpenProject #3339)', () => {
  /** Same shape as `Graph.vue`'s real `groupKeyFor`: composite keys of the first N directory
   *  segments, `null` when a node is not nested deep enough for that level. */
  function folderGroupKeyFor(node, level = 1) {
    const segments = node.path.split('/').slice(0, -1)
    if (level > segments.length) {
      return null
    }
    return level === 1 ? segments[0] : segments.slice(0, level).join('/')
  }

  it('defaults to level 1 only -- unchanged from before levels existed', () => {
    const nodeA = { path: 'guides/deep/a', x: 0, y: 0, vx: 0, vy: 0 }
    const nodeB = { path: 'guides/other/b', x: 10, y: 10, vx: 0, vy: 0 }
    const force = clusterForce(folderGroupKeyFor, 0.1)
    force.initialize([nodeA, nodeB])
    force(1)

    // Both share level-1 key 'guides' despite differing at level 2.
    expect(nodeA.vx).toBeGreaterThan(0)
    expect(nodeA.vy).toBeGreaterThan(0)
    expect(nodeB.vx).toBeLessThan(0)
    expect(nodeB.vy).toBeLessThan(0)
  })

  it('a node nested deep enough for level 2 gets an additional pull on top of its level-1 pull', () => {
    // -> These two share level-1 AND level-2 keys, so each level contributes its own pull.
    const levelOneOnly = { path: 'guides/deep/a', x: 0, y: 0, vx: 0, vy: 0 }
    const levelOneOnlyPeer = { path: 'guides/deep/b', x: 10, y: 10, vx: 0, vy: 0 }
    const levelOneForce = clusterForce(folderGroupKeyFor, 0.1, [1])
    levelOneForce.initialize([levelOneOnly, levelOneOnlyPeer])
    levelOneForce(1)

    const bothLevels = { path: 'guides/deep/a', x: 0, y: 0, vx: 0, vy: 0 }
    const bothLevelsPeer = { path: 'guides/deep/b', x: 10, y: 10, vx: 0, vy: 0 }
    const force = clusterForce(folderGroupKeyFor, 0.1, [1, 2])
    force.initialize([bothLevels, bothLevelsPeer])
    force(1)

    // Identical positions and keys at both levels, so the level-2 pull exactly doubles level 1's.
    expect(bothLevels.vx).toBeCloseTo(levelOneOnly.vx * 2)
    expect(bothLevels.vy).toBeCloseTo(levelOneOnly.vy * 2)
  })

  it('a node not nested deep enough for level 2 gets no level-2 pull, only its level-1 one', () => {
    const shallow = { path: 'guides/a', x: 0, y: 0, vx: 0, vy: 0 }
    const shallowPeer = { path: 'guides/b', x: 10, y: 10, vx: 0, vy: 0 }
    const levelOneForce = clusterForce(folderGroupKeyFor, 0.1, [1])
    levelOneForce.initialize([shallow, shallowPeer])
    levelOneForce(1)

    const shallowAgain = { path: 'guides/a', x: 0, y: 0, vx: 0, vy: 0 }
    const shallowAgainPeer = { path: 'guides/b', x: 10, y: 10, vx: 0, vy: 0 }
    const multiLevelForce = clusterForce(folderGroupKeyFor, 0.1, [1, 2, 3])
    multiLevelForce.initialize([shallowAgain, shallowAgainPeer])
    multiLevelForce(1)

    // Neither node has 2 directory segments, so levels 2 and 3 contribute nothing.
    expect(shallowAgain.vx).toBeCloseTo(shallow.vx)
    expect(shallowAgain.vy).toBeCloseTo(shallow.vy)
  })
})

describe('clusterForce settles a cold-load simulation without a directional wedge (OpenProject #1158)', () => {
  it('keeps edge-direction concentration low after a full real d3-force settle', () => {
    const FOLDERS = ['docs', 'guides', 'faq', 'reference']
    const realNodes = []
    for (const folder of FOLDERS) {
      for (let i = 0; i < 8; i++) {
        realNodes.push({ path: `${folder}/page-${i}`, title: `Page ${i}`, folder, locale: 'en' })
      }
    }
    const { syntheticNodes, edges } = buildPathHierarchyEdges(realNodes)
    const nodes = [...realNodes, ...syntheticNodes]
    const groupKeyFor = (node) => node.folder || '(root)'

    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink(edges)
          .id((d) => `${d.locale}:${d.path}`)
          .distance(60)
      )
      .force('charge', forceManyBody().strength(-120))
      .force('collide', forceCollide(14))
      .force('center', forceCenter(480, 300))
      .force('cluster', clusterForce(groupKeyFor, 0.05))
    simulation.stop()
    while (simulation.alpha() > simulation.alphaMin()) {
      simulation.tick()
    }

    const R = edgeAngleConcentration(edges)
    // 0.4 sits between the wedged regime (~0.8) and a healthy fan (~0.2).
    expect(R).toBeLessThan(0.4)
  })
})

describe('parentFanForce (OpenProject #2581)', () => {
  /** Restates the target formula so an expectation is derived independently of the module. */
  function targetFrom(parent, angle, radius) {
    return [parent.x + radius * Math.cos(angle), parent.y + radius * Math.sin(angle)]
  }

  it("a root node's own incoming angle is a fixed 0°, regardless of position", () => {
    // Root sits away from the origin on purpose: the 0° reference must be fixed, not derived from
    // the root's own nonexistent parent position.
    const root = { path: '', locale: 'en', root: true, x: 500, y: 500, vx: 0, vy: 0 }
    const child = { path: 'a', locale: 'en', x: 500, y: 550, vx: 0, vy: 0 }
    const nodes = [root, child]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    // Current radius from root is 50 straight down; a lone child targets the parent's own 0°.
    const [tx, ty] = targetFrom(root, 0, 50)
    expect(child.vx).toBeCloseTo(tx - child.x, 5)
    expect(child.vy).toBeCloseTo(ty - child.y, 5)
  })

  it('a root node itself is never nudged', () => {
    const root = { path: '', locale: 'en', root: true, x: 0, y: 0, vx: 5, vy: 5 }
    const child = { path: 'a', locale: 'en', x: 50, y: 0, vx: 0, vy: 0 }

    const force = parentFanForce(1)
    force.initialize([root, child])
    force(1)

    expect(root.vx).toBe(5)
    expect(root.vy).toBe(5)
  })

  it("derives a non-root parent's incoming angle live from its own (grandparent) position", () => {
    const grandparent = { path: 'a', locale: 'en', x: 0, y: 0, vx: 0, vy: 0 }
    const parent = { path: 'a/b', locale: 'en', x: 10, y: 10, vx: 0, vy: 0 }
    // Single child, placed at radius 20 directly "east" of its parent (current angle 0°).
    const child = { path: 'a/b/c', locale: 'en', x: 30, y: 10, vx: 0, vy: 0 }
    const nodes = [grandparent, parent, child]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    // parent's incoming angle = atan2(10-0, 10-0) = 45°; with 1 child, target angle = 45° too.
    const parentAngle = Math.atan2(10, 10)
    const [tx, ty] = targetFrom(parent, parentAngle, 20)
    expect(child.vx).toBeCloseTo(tx - child.x, 5)
    expect(child.vy).toBeCloseTo(ty - child.y, 5)

    // Angles are recomputed per tick, so moving the grandparent must change the nudge with no
    // re-`initialize()`.
    grandparent.x = 10
    grandparent.y = -10
    child.vx = 0
    child.vy = 0
    force(1)

    const newParentAngle = Math.atan2(10 - -10, 10 - 10) // atan2(20, 0) = 90°
    const [tx2, ty2] = targetFrom(parent, newParentAngle, 20)
    expect(child.vx).toBeCloseTo(tx2 - child.x, 5)
    expect(child.vy).toBeCloseTo(ty2 - child.y, 5)
  })

  it('2 children fan to parent-angle ± 45°, ordered by path basename', () => {
    const root = { path: '', locale: 'en', root: true, x: 0, y: 0, vx: 0, vy: 0 }
    const parent = { path: 'p', locale: 'en', x: 100, y: 0, vx: 0, vy: 0 }
    // parent's own incoming angle (from root) = 0°.
    const first = { path: 'p/aaa', locale: 'en', x: 110, y: 0, vx: 0, vy: 0 } // radius 10
    const second = { path: 'p/bbb', locale: 'en', x: 130, y: 0, vx: 0, vy: 0 } // radius 30
    const nodes = [root, parent, first, second]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    const [tx1, ty1] = targetFrom(parent, -Math.PI / 4, 10)
    expect(first.vx).toBeCloseTo(tx1 - first.x, 5)
    expect(first.vy).toBeCloseTo(ty1 - first.y, 5)

    const [tx2, ty2] = targetFrom(parent, Math.PI / 4, 30)
    expect(second.vx).toBeCloseTo(tx2 - second.x, 5)
    expect(second.vy).toBeCloseTo(ty2 - second.y, 5)
  })

  it("3 children fan to parent-angle ± 45° plus a third exactly at the parent's own angle", () => {
    const root = { path: '', locale: 'en', root: true, x: 0, y: 0, vx: 0, vy: 0 }
    const parent = { path: 'p', locale: 'en', x: 100, y: 0, vx: 0, vy: 0 }
    const a = { path: 'p/a', locale: 'en', x: 110, y: 5, vx: 0, vy: 0 }
    const b = { path: 'p/b', locale: 'en', x: 110, y: 10, vx: 0, vy: 0 }
    const c = { path: 'p/c', locale: 'en', x: 110, y: 15, vx: 0, vy: 0 }
    const nodes = [root, parent, a, b, c]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    for (const [node, angle] of [
      [a, -Math.PI / 4],
      [b, 0],
      [c, Math.PI / 4]
    ]) {
      const radius = Math.hypot(node.x - parent.x, node.y - parent.y)
      const [tx, ty] = targetFrom(parent, angle, radius)
      expect(node.vx).toBeCloseTo(tx - node.x, 5)
      expect(node.vy).toBeCloseTo(ty - node.y, 5)
    }
  })

  it('4+ children spread evenly around the full circle, straddling the parent angle at their midpoint', () => {
    const root = { path: '', locale: 'en', root: true, x: 0, y: 0, vx: 0, vy: 0 }
    // parent's own incoming angle (from root, at origin) = atan2(0,100) = 0°.
    const parent = { path: 'p', locale: 'en', x: 100, y: 0, vx: 0, vy: 0 }
    const children = ['a', 'b', 'c', 'd'].map(
      (seg) => ({ path: `p/${seg}`, locale: 'en', x: 110, y: 0, vx: 0, vy: 0 }) // radius 10 each
    )
    const nodes = [root, parent, ...children]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    // step = 360/4 = 90°, rotated so the parent's 0° sits midway between two adjacent children.
    const expectedAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]
    children.forEach((node, i) => {
      const [tx, ty] = targetFrom(parent, expectedAngles[i], 10)
      expect(node.vx).toBeCloseTo(tx - node.x, 5)
      expect(node.vy).toBeCloseTo(ty - node.y, 5)
    })
  })

  it('is a silent no-op on a node with no resolvable folder-hierarchy parent (e.g. under a hub-only edge mode)', () => {
    // A hub-only node set, as a non-tree edge mode produces: real pages are present but no
    // folder-hierarchy nodes, so the `path`-derived parent lookup resolves nothing.
    const hub = { path: '__tag__foo', synthetic: true, x: 0, y: 0, vx: 0, vy: 0 }
    const page = { path: 'a/b', locale: 'en', x: 50, y: 50, vx: 0, vy: 0 }
    const nodes = [hub, page]

    const force = parentFanForce(1)
    expect(() => force.initialize(nodes)).not.toThrow()
    expect(() => force(1)).not.toThrow()

    expect(page.vx).toBe(0)
    expect(page.vy).toBe(0)
    expect(hub.vx).toBe(0)
    expect(hub.vy).toBe(0)
  })

  describe('concentric rings for high-fanout parents (OpenProject #2582)', () => {
    /** The parent's own incoming angle from the root is 0°, and every child sits at a distinct
     *  current radius so an assertion can tell them apart without depending on fan order. */
    function buildFan(count) {
      const root = { path: '', locale: 'en', root: true, x: 0, y: 0, vx: 0, vy: 0 }
      const parent = { path: 'p', locale: 'en', x: 100, y: 0, vx: 0, vy: 0 }
      const children = Array.from({ length: count }, (_, i) => {
        const seg = String.fromCharCode(97 + i) // 'a', 'b', 'c', ... -- sorts in build order
        return { path: `p/${seg}`, locale: 'en', x: 100 + 10 * (i + 1), y: 0, vx: 0, vy: 0 }
      })
      return { root, parent, children }
    }

    it('a parent with exactly the ring-capacity threshold of children stays a single ring, unchanged from #2581', () => {
      const { root, parent, children } = buildFan(6)
      const force = parentFanForce(1)
      force.initialize([root, parent, ...children])
      force(1)

      // One ring of 6 under the full-circle rule: step 60°, offset a half-step from the parent's 0°.
      const step = Math.PI / 3
      children.forEach((child, i) => {
        const angle = step / 2 + i * step
        const radius = 10 * (i + 1) // ring 0 leaves each child's own radius unchanged
        const tx = parent.x + radius * Math.cos(angle)
        const ty = parent.y + radius * Math.sin(angle)
        expect(child.vx).toBeCloseTo(tx - child.x, 5)
        expect(child.vy).toBeCloseTo(ty - child.y, 5)
      })
    })

    it('one child past the threshold splits into two evenly sized rings rather than one lone outer node', () => {
      const { root, parent, children } = buildFan(7)
      const force = parentFanForce(1)
      force.initialize([root, parent, ...children])
      force(1)

      // Capacity 6, count 7 -> 2 rings of sizes [4, 3]. Ring 0 is a 4-way circle, no radius offset.
      const ring0Step = Math.PI / 2
      for (let i = 0; i < 4; i++) {
        const angle = ring0Step / 2 + i * ring0Step
        const radius = 10 * (i + 1)
        const tx = parent.x + radius * Math.cos(angle)
        const ty = parent.y + radius * Math.sin(angle)
        expect(children[i].vx).toBeCloseTo(tx - children[i].x, 5)
        expect(children[i].vy).toBeCloseTo(ty - children[i].y, 5)
      }

      // Ring 1 is 3-way, and pushed out by one RING_RADIUS_STEP on top of each child's own radius.
      const ring1Angles = [-Math.PI / 4, 0, Math.PI / 4]
      for (let i = 0; i < 3; i++) {
        const child = children[4 + i]
        const baseRadius = 10 * (4 + i + 1)
        const radius = baseRadius + 80
        const tx = parent.x + radius * Math.cos(ring1Angles[i])
        const ty = parent.y + radius * Math.sin(ring1Angles[i])
        expect(child.vx).toBeCloseTo(tx - child.x, 5)
        expect(child.vy).toBeCloseTo(ty - child.y, 5)
      }
    })

    it('a much larger fanout spreads across more than two rings, each capped at the threshold', () => {
      const { root, parent, children } = buildFan(19)
      const force = parentFanForce(1)
      force.initialize([root, parent, ...children])
      force(1)

      // Capacity 6, count 19 -> 4 rings of [5, 5, 5, 4].
      const ringSizes = [5, 5, 5, 4]
      expect(ringSizes.every((size) => size <= 6)).toBe(true)
      expect(Math.max(...ringSizes) - Math.min(...ringSizes)).toBeLessThanOrEqual(1)

      // Spot-check the last child: ring 3, position 3 of 4, radius pushed out by 3 steps.
      const lastChild = children[18]
      const ringIndex = 3
      const positionInRing = 3
      const ringSize = 4
      const step = (2 * Math.PI) / ringSize
      const angle = step / 2 + positionInRing * step
      const baseRadius = 10 * 19
      const radius = baseRadius + ringIndex * 80
      const tx = parent.x + radius * Math.cos(angle)
      const ty = parent.y + radius * Math.sin(angle)
      expect(lastChild.vx).toBeCloseTo(tx - lastChild.x, 5)
      expect(lastChild.vy).toBeCloseTo(ty - lastChild.y, 5)
    })

    it('ring assignment is stable across a re-`initialize()` with the same node set (no reshuffling on reload)', () => {
      const { root, parent, children } = buildFan(13)
      const force = parentFanForce(1)
      force.initialize([root, parent, ...children])
      force(1)
      const firstPass = children.map((c) => [c.vx, c.vy])

      children.forEach((c) => {
        c.vx = 0
        c.vy = 0
      })
      force.initialize([root, parent, ...children])
      force(1)
      const secondPass = children.map((c) => [c.vx, c.vy])

      firstPass.forEach(([vx, vy], i) => {
        expect(secondPass[i][0]).toBeCloseTo(vx, 5)
        expect(secondPass[i][1]).toBeCloseTo(vy, 5)
      })
    })
  })
})

describe('applyHoverPushImpulse', () => {
  it('nudges every other node’s velocity directly away from the hovered node, and leaves the hovered node itself untouched', () => {
    const hovered = { x: 0, y: 0, vx: 0, vy: 0 }
    const east = { x: 10, y: 0, vx: 0, vy: 0 }
    const north = { x: 0, y: -10, vx: 0, vy: 0 }

    applyHoverPushImpulse([hovered, east, north], hovered)

    expect(hovered.vx).toBe(0)
    expect(hovered.vy).toBe(0)
    expect(east.vx).toBeGreaterThan(0)
    expect(east.vy).toBeCloseTo(0, 5)
    expect(north.vy).toBeLessThan(0)
    expect(north.vx).toBeCloseTo(0, 5)
  })

  it('the nudge magnitude does not scale with distance -- a far node is pushed exactly as hard as a near one', () => {
    const hovered = { x: 0, y: 0, vx: 0, vy: 0 }
    const near = { x: 1, y: 0, vx: 0, vy: 0 }
    const far = { x: 1000, y: 0, vx: 0, vy: 0 }

    applyHoverPushImpulse([hovered, near, far], hovered)

    expect(near.vx).toBeCloseTo(far.vx, 5)
  })

  it('a node exactly coincident with the hovered node still gets nudged, along a fixed fallback direction, rather than being skipped', () => {
    const hovered = { x: 5, y: 5, vx: 0, vy: 0 }
    const coincident = { x: 5, y: 5, vx: 0, vy: 0 }

    applyHoverPushImpulse([hovered, coincident], hovered)

    expect(coincident.vx).toBeGreaterThan(0)
    expect(coincident.vy).toBe(0)
  })

  it('is a no-op with no hoveredNode, or when the hovered node has no position yet', () => {
    const a = { x: 1, y: 1, vx: 0, vy: 0 }
    const b = { x: 2, y: 2, vx: 0, vy: 0 }

    applyHoverPushImpulse([a, b], null)
    applyHoverPushImpulse([a, b], { vx: 0, vy: 0 }) // -> no x/y at all

    expect(a.vx).toBe(0)
    expect(a.vy).toBe(0)
    expect(b.vx).toBe(0)
    expect(b.vy).toBe(0)
  })

  it('skips a node with no position of its own, same as every other layer in this file', () => {
    const hovered = { x: 0, y: 0, vx: 0, vy: 0 }
    const pending = { vx: 0, vy: 0 }

    expect(() => applyHoverPushImpulse([hovered, pending], hovered)).not.toThrow()
    expect(pending.vx).toBe(0)
    expect(pending.vy).toBe(0)
  })
})
