import { describe, expect, it } from 'vitest'
import { isReactive } from 'vue'

import { drawLabels, LABEL_GAP } from './graphDraw.js'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #1837/#2296/#2297: what stays out of deep reactivity, which of `relayout()`/
 * `repaint()` rebuilds what, and how cluster hulls and labels size themselves off each node's own
 * drawn radius rather than a flat constant.
 */
describe('Graph.vue layout, reactivity and repaint', () => {
  it('keeps node/edge arrays and node objects out of deep reactivity (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> The arrays handed to `forceSimulation`/`forceLink` are `shallowRef`s, and every node/edge
    //    inside them is `markRaw()`'d as it's built -- neither the arrays nor their contents should
    //    ever become a Vue reactive proxy, since d3-force writes `x`/`y`/`vx`/`vy` on every node on
    //    every tick and nothing renders off these values reactively (canvas-only).
    expect(isReactive(wrapper.vm.nodes)).toBe(false)
    expect(isReactive(wrapper.vm.edges)).toBe(false)
    expect(isReactive(wrapper.vm.allNodes)).toBe(false)
    expect(isReactive(wrapper.vm.allEdges)).toBe(false)
    expect(wrapper.vm.nodes.length).toBeGreaterThan(0)
    for (const node of wrapper.vm.nodes) {
      expect(isReactive(node)).toBe(false)
    }
    for (const edge of wrapper.vm.edges) {
      expect(isReactive(edge)).toBe(false)
    }
  })

  it('relayout() rebuilds the quadtree and recomputes clusters; repaint() does neither (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    const quadtreeBeforeRepaint = wrapper.vm.nodeQuadtree
    const clustersBeforeRepaint = wrapper.vm.clusters
    wrapper.vm.repaint()
    // -> A pure repaint must not touch layout-derived state -- same references, not just equal
    //    content, since `relayout()` always produces a brand new quadtree/clusters array.
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).toBe(clustersBeforeRepaint)

    wrapper.vm.relayout()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeRepaint)
  })

  it('the zoom handler only repaints; the simulation tick handler relayouts then repaints (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> Exercises the zoom-only path the way `attachZoom()`'s `.on('zoom', ...)` callback does
    //    (set the transform, repaint) rather than driving a real DOM zoom gesture through jsdom.
    const quadtreeBeforeZoom = wrapper.vm.nodeQuadtree
    const clustersBeforeZoom = wrapper.vm.clusters
    wrapper.vm.zoomTransform = { k: 2, x: 5, y: 5 }
    wrapper.vm.repaint()
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).toBe(clustersBeforeZoom)

    // -> The actual registered 'tick' listener, retrieved off the live simulation the same
    //    get-form way -- confirms `startSimulation()` really wired both steps together, not just
    //    that `relayout`/`repaint` behave correctly called by hand.
    const tickListener = wrapper.vm.simulation.on('tick')
    expect(typeof tickListener).toBe('function')
    tickListener()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeZoom)
  })

  it("sizes the fallback circle off the largest member node's edge, not just its centre (OpenProject #2296)", async () => {
    const wrapper = await mountGraph()

    // -> Distinct `folder` values put A and B in separate groups, each a single-node fallback-
    //    circle case (`maxDist` from centroid is 0) -- including a group of exactly one node at
    //    maximum radius, per the Done-when.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.folder = 'group-a'
    nodeB.folder = 'group-b'
    nodeA.x = 100
    nodeA.y = 100
    nodeB.x = 300
    nodeB.y = 300
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }

    wrapper.vm.computeClusters()

    // -> A is now the top of the graph's own observed range (OpenProject #2561's min/max lerp is
    //    normalized against the current graph, not an absolute count) -- pinned at MAX_NODE_RADIUS.
    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
    const clusterA = wrapper.vm.clusters.find((c) => c.key === 'group-a')
    expect(clusterA.circle).toBeDefined()
    expect(clusterA.circle.r).toBeGreaterThan(wrapper.vm.radiusFor(nodeA))
  })

  it("grows hull padding by each vertex's own node radius, not a flat constant (OpenProject #2296)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> A third node so this group has >=3 members and takes the `polygonHull` path rather than
    //    falling back to the circle case covered above.
    const nodeC = { ...nodeB, path: 'c' }
    wrapper.vm.nodes.push(nodeC)

    for (const node of [nodeA, nodeB, nodeC]) {
      node.folder = 'group-c'
    }
    nodeA.x = 0
    nodeA.y = 200
    nodeB.x = 100
    nodeB.y = 0
    nodeC.x = 200
    nodeC.y = 0
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }

    wrapper.vm.computeClusters()

    const clusterC = wrapper.vm.clusters.find((c) => c.key === 'group-c')
    expect(clusterC.hullPoints).toBeDefined()
    const cx = (nodeA.x + nodeB.x + nodeC.x) / 3
    const cy = (nodeA.y + nodeB.y + nodeC.y) / 3
    const distToNodeA = Math.hypot(nodeA.x - cx, nodeA.y - cy)
    const maxHullDist = Math.max(...clusterC.hullPoints.map(([x, y]) => Math.hypot(x - cx, y - cy)))
    // -> A flat 16px padding would fall short here since nodeA's radius (pinned at MAX_NODE_RADIUS,
    //    110, as the graph's sole non-zero node) far exceeds it -- this only passes once the hull
    //    vertex at A is pushed out by A's own radius too.
    expect(maxHullDist).toBeGreaterThan(distToNodeA + wrapper.vm.radiusFor(nodeA))
  })

  it("drawLabels offsets each label by that node's own drawn radius, not a fixed constant (OpenProject #2297)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 100
    nodeA.y = 100
    nodeB.x = 200
    nodeB.y = 200

    const radiusA = wrapper.vm.radiusFor(nodeA)
    const radiusB = wrapper.vm.radiusFor(nodeB)
    // -> The fixture's two nodes have different contributor counts, so their radii differ --
    //    otherwise this test couldn't distinguish "offset tracks radius" from "offset is still
    //    a constant that happens to equal both radii plus the gap".
    expect(radiusA).not.toBe(radiusB)

    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 1.2)

    const callA = wrapper.vm.ctx.fillText.mock.calls.find(([text]) => text === nodeA.title)
    const callB = wrapper.vm.ctx.fillText.mock.calls.find(([text]) => text === nodeB.title)

    expect(callA[1]).toBe(nodeA.x + radiusA + LABEL_GAP)
    expect(callB[1]).toBe(nodeB.x + radiusB + LABEL_GAP)
  })
})
