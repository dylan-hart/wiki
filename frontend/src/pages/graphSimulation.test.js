import { describe, expect, it } from 'vitest'

import { chargeStrengthFor, computeClusters, linkDistanceFor } from './graphSimulation.js'

/**
 * `startSimulation()` itself (the d3-force wiring) is exercised indirectly through
 * `Graph.layout.test.js`'s real-mount suites, which drive an actual simulation. This file covers
 * the pure math `graphSimulation.js` owns directly: the per-item `linkDistanceFor`/
 * `chargeStrengthFor` accessors (OpenProject #2562) that `startSimulation()` wires into
 * `forceLink().distance()`/`forceManyBody().strength()`, and `computeClusters()`'s hull/circle
 * padding.
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

  it("a single-node group's fallback circle radius is exactly the current HULL_PADDING", () => {
    const nodes = [{ x: 0, y: 0, folder: 'g' }]
    const clusters = computeClusters(nodes, {
      groupKeyFor: (n) => n.folder,
      colorForGroup: () => '#000',
      radiusFor: zeroRadius
    })
    const cluster = clusters.find((c) => c.key === 'g')
    expect(cluster.circle).toBeDefined()
    // -> With every node radius zeroed out, maxDist collapses to 0, so whatever is left over is
    //    exactly the flat HULL_PADDING term this WP raised from 16 to 24 -- pinning the new value
    //    without importing an unexported constant.
    expect(cluster.circle.r).toBe(24)
  })

  it("a >=3-node group's hull vertices are pushed out from centroid by exactly HULL_PADDING when every node radius is zero", () => {
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
    expect(cluster.hullPoints).toBeDefined()
    // -> All three form a triangle, so every input node is itself a hull vertex -- each one pushed
    //    straight out from the shared centroid by exactly the flat HULL_PADDING term (`24`, raised
    //    from `16` by this WP), since `radiusFor` is zeroed out for every node here.
    const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length
    const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length
    const expectedPoints = nodes.map((n) => {
      const dx = n.x - cx
      const dy = n.y - cy
      const len = Math.hypot(dx, dy)
      return [n.x + (dx / len) * 24, n.y + (dy / len) * 24]
    })
    for (const [ex, ey] of expectedPoints) {
      const match = cluster.hullPoints.find(([hx, hy]) => Math.hypot(hx - ex, hy - ey) < 1e-6)
      expect(match).toBeDefined()
    }
  })

  it('a floor-sized node already gets more total clearance after OpenProject #2594 doubled MIN_NODE_RADIUS, with no HULL_PADDING change', () => {
    // -> HULL_PADDING is a flat term ADDED ON TOP of radiusFor(node) per vertex, so the doubled
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
