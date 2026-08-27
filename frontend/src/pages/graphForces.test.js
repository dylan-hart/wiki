import { describe, expect, it } from 'vitest'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { buildPathHierarchyEdges } from './graphFilters.js'
import { clusterForce } from './graphForces.js'

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
