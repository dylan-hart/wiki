import { describe, expect, it } from 'vitest'

import { chargeStrengthFor, computeClusters, linkDistanceFor } from './graphSimulation.js'

/**
 * `startSimulation()` itself (the d3-force wiring) is exercised indirectly through
 * `Graph.layout.test.js`'s real-mount suites, which drive an actual simulation. This file covers
 * the pure math `graphSimulation.js` owns directly: the per-item `linkDistanceFor`/
 * `chargeStrengthFor` accessors (OpenProject #2562) that `startSimulation()` wires into
 * `forceLink().distance()`/`forceManyBody().strength()`, and `computeClusters()`'s circle padding.
 */
describe('linkDistanceFor (OpenProject #2562)', () => {
  const collideRadiusFor = (node) => node.radius + 2

  it('grows with both endpoints radii, not a flat number', () => {
    const small = linkDistanceFor(
      { source: { radius: 5 }, target: { radius: 5 } },
      collideRadiusFor
    )
    const large = linkDistanceFor(
      { source: { radius: 110 }, target: { radius: 110 } },
      collideRadiusFor
    )
    expect(large).toBeGreaterThan(small)
  })

  it('a link between one small and one large node sits between the two same-size cases', () => {
    const bothSmall = linkDistanceFor(
      { source: { radius: 5 }, target: { radius: 5 } },
      collideRadiusFor
    )
    const bothLarge = linkDistanceFor(
      { source: { radius: 110 }, target: { radius: 110 } },
      collideRadiusFor
    )
    const mixed = linkDistanceFor(
      { source: { radius: 5 }, target: { radius: 110 } },
      collideRadiusFor
    )
    expect(mixed).toBeGreaterThan(bothSmall)
    expect(mixed).toBeLessThan(bothLarge)
  })

  it('lands close to the old flat 60 distance when both endpoints sit at the old 22px ceiling', () => {
    const atOldCeiling = linkDistanceFor(
      { source: { radius: 22 }, target: { radius: 22 } },
      collideRadiusFor
    )
    // -> Not equal (the old constant never accounted for node size at all), but in the same
    //    ballpark rather than wildly off, as a sanity check against the value it replaces.
    expect(atOldCeiling).toBeGreaterThan(60)
    expect(atOldCeiling).toBeLessThan(120)
  })
})

describe('chargeStrengthFor (OpenProject #2562)', () => {
  const radiusFor = (node) => node.radius

  it('is more negative (stronger repulsion) for a larger node', () => {
    const small = chargeStrengthFor({ radius: 5 }, radiusFor)
    const large = chargeStrengthFor({ radius: 110 }, radiusFor)
    expect(large).toBeLessThan(small)
  })

  it('lands close to the old flat -120 charge at the old 22px ceiling', () => {
    const atOldCeiling = chargeStrengthFor({ radius: 22 }, radiusFor)
    expect(atOldCeiling).toBeLessThan(-100)
    expect(atOldCeiling).toBeGreaterThan(-140)
  })

  it('a node at the new 110px ceiling repels several times harder than the old ceiling did', () => {
    const atOldCeiling = chargeStrengthFor({ radius: 22 }, radiusFor)
    const atNewCeiling = chargeStrengthFor({ radius: 110 }, radiusFor)
    expect(atNewCeiling).toBeLessThan(atOldCeiling * 3)
  })
})

describe('computeClusters padding (OpenProject #2562)', () => {
  const zeroRadius = () => 0

  it("a single-node group's circle radius is exactly the current CLUSTER_PADDING", () => {
    const nodes = [{ x: 0, y: 0, folder: 'g' }]
    const clusters = computeClusters(nodes, {
      groupKeyFor: (n) => n.folder,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })
    const cluster = clusters.find((c) => c.key === 'g')
    expect(cluster.circle).toBeDefined()
    // -> With every node radius zeroed out, maxDist collapses to 0, so whatever is left over is
    //    exactly the flat CLUSTER_PADDING term this WP raised from 16 to 24 -- pinning the new value
    //    without importing an unexported constant.
    expect(cluster.circle.r).toBe(24)
  })

  it('a >=3-node group also gets a circle, never a hull (OpenProject #2836)', () => {
    const nodes = [
      { x: 0, y: 0, folder: 'g' },
      { x: 100, y: 0, folder: 'g' },
      { x: 0, y: 100, folder: 'g' }
    ]
    const clusters = computeClusters(nodes, {
      groupKeyFor: (n) => n.folder,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })
    const cluster = clusters.find((c) => c.key === 'g')
    expect(cluster.hullPoints).toBeUndefined()
    expect(cluster.circle).toBeDefined()
    // -> The centroid of this right triangle is (100/3, 100/3); with every node radius zeroed out,
    //    the circle's radius is exactly the farthest member's distance from centroid plus the flat
    //    CLUSTER_PADDING term (`24`).
    const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length
    const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length
    const maxDist = Math.max(...nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)))
    expect(cluster.circle.x).toBeCloseTo(cx)
    expect(cluster.circle.y).toBeCloseTo(cy)
    expect(cluster.circle.r).toBeCloseTo(maxDist + 24)
  })

  it('a floor-sized node already gets more total clearance after OpenProject #2594 doubled MIN_NODE_RADIUS, with no CLUSTER_PADDING change', () => {
    // -> CLUSTER_PADDING is a flat term ADDED ON TOP of radiusFor(node) per vertex, so the doubled
    //    floor (5 -> 10, OpenProject #2594) already flows through the radius term alone: 24 + 5 =
    //    29 at the old floor, 24 + 10 = 34 at the new one. This pins that reasoning (the
    //    "no numeric change needed here" conclusion in OpenProject #2562's own re-tuning pass) as
    //    an executable check rather than leaving it only in a doc comment.
    const radiusFor = (n) => n.radius
    const oldFloor = computeClusters([{ x: 0, y: 0, folder: 'g', radius: 5 }], {
      groupKeyFor: (n) => n.folder,
      colorForGroup: () => '#000',
      radiusFor
    }).find((c) => c.key === 'g')
    const newFloor = computeClusters([{ x: 0, y: 0, folder: 'g', radius: 10 }], {
      groupKeyFor: (n) => n.folder,
      colorForGroup: () => '#000',
      radiusFor
    }).find((c) => c.key === 'g')
    expect(oldFloor.circle.r).toBe(29)
    expect(newFloor.circle.r).toBe(34)
  })
})

describe('computeClusters synthetic-node membership (OpenProject #3355)', () => {
  const zeroRadius = () => 0
  // -> Mirrors `Graph.vue#groupKeyFor`'s own `'(root)'` fallback for a folder-less real page, not
  //    just the earlier `describe` blocks' bare `n.folder` (which never needed it -- none of their
  //    fixtures used an empty/root folder).
  const groupKeyFor = (n) => n.folder || '(root)'
  const parentGroupKeyFor = (n) => (n.path.includes('/') ? n.path.split('/')[0] : '(root)')

  it("a nested folder node joins its parent folder's circle as a member", () => {
    const pageA = { x: 0, y: 0, path: 'A/page', folder: 'A' }
    const folderB = { x: 300, y: 0, path: 'A/B', synthetic: true }
    const nodes = [pageA, folderB]

    const clusters = computeClusters(nodes, {
      groupKeyFor,
      parentGroupKeyFor,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })

    const clusterA = clusters.find((c) => c.key === 'A')
    expect(clusterA).toBeDefined()
    // -> With only pageA and folderB as members, the centroid sits exactly between them -- proof
    //    folderB was actually folded into the average, not silently dropped the way it used to be.
    expect(clusterA.circle.x).toBeCloseTo(150)
    expect(clusterA.circle.y).toBeCloseTo(0)
  })

  it('the true root node is never a member of any circle, even with parentGroupKeyFor supplied', () => {
    const root = { x: 0, y: 0, path: '', synthetic: true, root: true }
    const page = { x: 100, y: 0, path: 'a', folder: '' }

    const clusters = computeClusters([root, page], {
      groupKeyFor,
      parentGroupKeyFor,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })

    const rootCluster = clusters.find((c) => c.key === '(root)')
    // -> Only `page` (folder: '') is a member -- if `root` had been folded in too, the centroid
    //    would sit at (50, 0), not exactly on `page`.
    expect(rootCluster.circle.x).toBeCloseTo(100)
  })

  it('a top-level folder never lands inside the circle it is itself the namer of', () => {
    const folderA = { x: 500, y: 500, path: 'A', synthetic: true }
    const pageInA = { x: 0, y: 0, path: 'A/page', folder: 'A' }

    const clusters = computeClusters([folderA, pageInA], {
      groupKeyFor,
      parentGroupKeyFor,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })

    // -> folderA's own parent key is '(root)' (its path has no '/'), never 'A' -- the key its own
    //    children use -- so the 'A' circle has exactly one member: pageInA.
    const clusterA = clusters.find((c) => c.key === 'A')
    expect(clusterA.circle.x).toBeCloseTo(0)
    expect(clusterA.circle.y).toBeCloseTo(0)
    const rootCluster = clusters.find((c) => c.key === '(root)')
    expect(rootCluster.circle.x).toBeCloseTo(500)
    expect(rootCluster.circle.y).toBeCloseTo(500)
  })

  it('a synthetic node is still excluded outright when the caller passes no parentGroupKeyFor (pre-#3355 call sites)', () => {
    const folder = { x: 0, y: 0, path: 'A', synthetic: true }
    const page = { x: 100, y: 0, path: 'A/page', folder: 'A' }

    const clusters = computeClusters([folder, page], {
      groupKeyFor,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })

    const clusterA = clusters.find((c) => c.key === 'A')
    expect(clusterA.circle.x).toBeCloseTo(100)
    expect(clusters.length).toBe(1)
  })
})
