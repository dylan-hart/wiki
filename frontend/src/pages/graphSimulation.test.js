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

/**
 * `levels` (OpenProject #3339, folder-mode nested grouping circles) -- `computeClusters()` buckets
 * on a composite key per level via a `groupKeyFor(node, level)` accessor, e.g. the way `Graph.vue`'s
 * own `groupKeyFor` computes: level 1 = `node.folder`, level 2 = the first two directory segments of
 * `node.path` joined, level 3 = the first three. A node not nested deep enough for a level returns
 * `null` for it, excluding it from that level's bucketing entirely -- same convention any grouping
 * mode already used for "no key". These tests exercise `computeClusters()` directly against a small
 * stand-in `groupKeyFor` shaped exactly like that, rather than importing `Graph.vue` itself.
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
    // -> Only the outermost (level 1) level resolves a real color; 2/3 defer to the draw layer's
    //    own shared-neutral-fill decision (Feature #3338's scope, owned by the sibling Task).
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
    // -> A node's `groupKeyFor` call count should scale with N * levels.length, not N^2: this counts
    //    calls to prove `computeClusters()` never re-scans `nodes` once per distinct group (which a
    //    naive "filter per key" implementation would do).
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
    // -> Exactly one `groupKeyFor` call per node per level (the bucketing pass) -- a second,
    //    per-group re-filter pass would multiply this by the number of distinct groups instead.
    expect(calls).toBe(nodes.length * 3)
  })
})
