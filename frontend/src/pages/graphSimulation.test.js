import { describe, expect, it } from 'vitest'

import { chargeStrengthFor, computeClusters, linkDistanceFor } from './graphSimulation.js'

/** Pure math only -- `startSimulation()`'s d3-force wiring is driven by `Graph.layout.test.js`. */
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
    // -> Radius zeroed so `maxDist` collapses to 0 and the remainder is exactly CLUSTER_PADDING,
    //    which is not exported.
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
    const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length
    const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length
    const maxDist = Math.max(...nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)))
    expect(cluster.circle.x).toBeCloseTo(cx)
    expect(cluster.circle.y).toBeCloseTo(cy)
    expect(cluster.circle.r).toBeCloseTo(maxDist + 24)
  })

  it('a floor-sized node already gets more total clearance after OpenProject #2594 doubled MIN_NODE_RADIUS, with no CLUSTER_PADDING change', () => {
    // -> CLUSTER_PADDING is a flat term added on top of `radiusFor(node)` per vertex, so a doubled
    //    radius floor flows through the radius term alone: 24 + 5 = 29, 24 + 10 = 34.
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

/**
 * `folderGroupKeyFor` below is a stand-in shaped like `Graph.vue`'s own accessor -- level 1 =
 * `node.folder`, level n = the first n directory segments joined, `null` when the node is not that
 * deep -- so these can drive `computeClusters()` without mounting the page.
 */
describe('computeClusters levels (OpenProject #3339)', () => {
  const zeroRadius = () => 0
  const colorForGroup = () => '#000'

  function folderGroupKeyFor(node, level = 1) {
    const segments = node.path.split('/').slice(0, -1)
    if (level > segments.length) {
      return null
    }
    return level === 1 ? segments[0] : segments.slice(0, level).join('/')
  }

  it('a 3-level-deep node buckets correctly at all 3 levels', () => {
    const nodes = [{ x: 0, y: 0, path: 'guides/deep/very/page' }]
    const clusters = computeClusters(nodes, {
      groupKeyFor: folderGroupKeyFor,
      colorForGroup,
      radiusFor: zeroRadius,
      levels: [1, 2, 3]
    })

    const level1 = clusters.find((c) => c.level === 1)
    const level2 = clusters.find((c) => c.level === 2)
    const level3 = clusters.find((c) => c.level === 3)
    expect(level1?.key).toBe('guides')
    expect(level2?.key).toBe('guides/deep')
    expect(level3?.key).toBe('guides/deep/very')
    expect(level1.color).toBe('#000')
    expect(level2.color).toBeNull()
    expect(level3.color).toBeNull()
  })

  it('a 1-level-deep node (no subfolder) produces no level-2/3 cluster entry for itself', () => {
    const nodes = [{ x: 0, y: 0, path: 'guides/page' }]
    const clusters = computeClusters(nodes, {
      groupKeyFor: folderGroupKeyFor,
      colorForGroup,
      radiusFor: zeroRadius,
      levels: [1, 2, 3]
    })

    expect(clusters.some((c) => c.level === 1)).toBe(true)
    expect(clusters.some((c) => c.level === 2)).toBe(false)
    expect(clusters.some((c) => c.level === 3)).toBe(false)
  })

  it('defaults to level 1 only, unchanged from before levels existed', () => {
    const nodes = [{ x: 0, y: 0, path: 'guides/deep/very/page' }]
    const clusters = computeClusters(nodes, {
      groupKeyFor: folderGroupKeyFor,
      colorForGroup,
      radiusFor: zeroRadius
    })

    expect(clusters).toHaveLength(1)
    expect(clusters[0].level).toBe(1)
    expect(clusters[0].key).toBe('guides')
  })

  it('the composite-key bucketing stays O(N) -- one Map-based pass per level, not repeated filtering', () => {
    // -> Counting `groupKeyFor` calls is what separates one bucketing pass per level from a naive
    //    filter-per-key implementation, which would re-scan `nodes` once per distinct group.
    const nodes = []
    for (let i = 0; i < 50; i++) {
      nodes.push({ x: i, y: 0, path: `folder-${i % 5}/sub-${i % 3}/page-${i}` })
    }
    let calls = 0
    const countingGroupKeyFor = (node, level) => {
      calls += 1
      return folderGroupKeyFor(node, level)
    }
    computeClusters(nodes, {
      groupKeyFor: countingGroupKeyFor,
      colorForGroup,
      radiusFor: zeroRadius,
      levels: [1, 2, 3]
    })
    expect(calls).toBe(nodes.length * 3)
  })
})

describe('computeClusters synthetic-node membership (OpenProject #3355)', () => {
  const zeroRadius = () => 0
  // -> Mirrors `Graph.vue#groupKeyFor`'s `'(root)'` fallback for a folder-less page, which these
  //    fixtures need and the earlier blocks' bare `n.folder` did not.
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
    // -> The centroid sits midway only if folderB was folded into the average rather than dropped.
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
    // -> Had `root` been folded in too, the centroid would sit at (50, 0), not on `page`.
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

    // -> folderA's own parent key is '(root)' (its path has no '/'), never the 'A' its children
    //    use, so the 'A' circle has exactly one member: pageInA.
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
