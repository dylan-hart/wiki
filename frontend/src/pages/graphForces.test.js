import { describe, expect, it } from 'vitest'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { buildPathHierarchyEdges } from './graphFilters.js'
import { clusterForce, parentFanForce } from './graphForces.js'

/**
 * Circular concentration R of a set of edge directions -- 1 means every edge points the same way
 * (the degenerate NW wedge OpenProject #1158 reproduces), ~0 means directions are spread out (a
 * normal radial fan). `sqrt((sum cos)^2 + (sum sin)^2) / n`, the standard mean-resultant-length
 * formula for circular data. Matches how #1158's root-cause investigation measured the bug (R=0.83
 * on cold load) and the fix (R=0.16) -- see that WP for the full derivation.
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

    // group centroid (excluding the synthetic node) is (5, 5) -- nodeA is pulled toward +x/+y,
    // nodeB (already past it) is pulled back toward -x/-y.
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

    // Move the group's centroid further away between calls -- a cached-at-initialize force (the
    // #1158 bug) would keep pulling nodeA toward the stale (50, 0) centroid; this one must react.
    nodeB.x = 1000
    nodeA.vx = 0
    force(1)

    expect(nodeA.vx).toBeGreaterThan(firstPull)
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
    // Bug (cached forceX/forceY targets near the origin) measures ~0.83; the fix measures ~0.16.
    expect(R).toBeLessThan(0.4)
  })
})

describe('parentFanForce (OpenProject #2581)', () => {
  /** Builds `[targetX, targetY]` for a node at `radius` from `parent`, at `angle` -- the same
   *  formula `parentFanForce` itself computes, used here to derive the expected nudge independently
   *  of the module's own internals. */
  function targetFrom(parent, angle, radius) {
    return [parent.x + radius * Math.cos(angle), parent.y + radius * Math.sin(angle)]
  }

  it("a root node's own incoming angle is a fixed 0°, regardless of position", () => {
    // Root sits away from the origin on purpose -- proves the 0° reference is fixed, not derived
    // from the root's own (nonexistent) parent position.
    const root = { path: '', locale: 'en', root: true, x: 500, y: 500, vx: 0, vy: 0 }
    const child = { path: 'a', locale: 'en', x: 500, y: 550, vx: 0, vy: 0 }
    const nodes = [root, child]

    const force = parentFanForce(1)
    force.initialize(nodes)
    force(1)

    // 1 child continues straight out at the parent's incoming angle (0°) -- current radius from
    // root is 50 straight down (angle 90°), so the nudge should pull it toward angle 0° (rightward,
    // same y as root).
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

    // Recomputed fresh every call, not cached from `initialize()` -- move the grandparent and the
    // nudge must react on the very next tick with no re-`initialize()`.
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

    // step = 360/4 = 90°; rotated so parent's 0° angle sits at the midpoint between two adjacent
    // children -> expected angles 45°, 135°, 225°, 315° (per the spec's own worked example).
    const expectedAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]
    children.forEach((node, i) => {
      const [tx, ty] = targetFrom(parent, expectedAngles[i], 10)
      expect(node.vx).toBeCloseTo(tx - node.x, 5)
      expect(node.vy).toBeCloseTo(ty - node.y, 5)
    })
  })

  it('is a silent no-op on a node with no resolvable folder-hierarchy parent (e.g. under a hub-only edge mode)', () => {
    // Mirrors what the node set looks like under `edgeMode: 'tags'`/`'classification'` -- real page
    // nodes are present but no folder-hierarchy synthetic nodes were built for them, so this force's
    // own `path`-derived parent lookup can't resolve anything.
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
})
