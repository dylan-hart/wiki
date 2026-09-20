import { describe, expect, it } from 'vitest'
import { isReactive } from 'vue'

import { drawLabels, LABEL_GAP } from './graphDraw.js'
import { mountGraph } from './graphFixtures.js'

describe('Graph.vue layout, reactivity and repaint', () => {
  it('keeps node/edge arrays and node objects out of deep reactivity (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> d3-force writes `x`/`y`/`vx`/`vy` on every node each tick and nothing renders off them
    //    reactively (canvas-only), so the arrays are `shallowRef`s and their contents `markRaw()`d.
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
    // -> Identity, not content: `relayout()` always produces a new quadtree/clusters array, so
    //    `toBe` is what distinguishes a repaint that left them alone.
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).toBe(clustersBeforeRepaint)

    wrapper.vm.relayout()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeRepaint)
  })

  it('the zoom handler only repaints; the simulation tick handler relayouts then repaints (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> Mimics `attachZoom()`'s zoom callback (set the transform, repaint); jsdom cannot drive a
    //    real zoom gesture.
    const quadtreeBeforeZoom = wrapper.vm.nodeQuadtree
    const clustersBeforeZoom = wrapper.vm.clusters
    wrapper.vm.zoomTransform = { k: 2, x: 5, y: 5 }
    wrapper.vm.repaint()
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).toBe(clustersBeforeZoom)

    // -> The listener `startSimulation()` actually registered, rather than calling
    //    `relayout`/`repaint` by hand: the wiring is what is under test.
    const tickListener = wrapper.vm.simulation.on('tick')
    expect(typeof tickListener).toBe('function')
    tickListener()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeZoom)
  })

  it("sizes the fallback circle off the largest member node's edge, not just its centre (OpenProject #2296)", async () => {
    const wrapper = await mountGraph()

    // -> Distinct `folder` values make each node its own group: the single-node fallback-circle
    //    case, where `maxDist` from the centroid is 0.
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

    // -> Radii lerp across the graph's own observed range, not an absolute count, so A sits at
    //    MAX_NODE_RADIUS.
    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
    const clusterA = wrapper.vm.clusters.find((c) => c.key === 'group-a')
    expect(clusterA.circle).toBeDefined()
    expect(clusterA.circle.r).toBeGreaterThan(wrapper.vm.radiusFor(nodeA))
  })

  it("grows the >=3-node circle by each member's own node radius, not a flat constant, and never draws a hull (OpenProject #2296/#2836)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> A third member: a >=3-node group takes the same circle case as a smaller one, no hull.
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
    expect(clusterC.hullPoints).toBeUndefined()
    expect(clusterC.circle).toBeDefined()
    const cx = (nodeA.x + nodeB.x + nodeC.x) / 3
    const cy = (nodeA.y + nodeB.y + nodeC.y) / 3
    const distToNodeA = Math.hypot(nodeA.x - cx, nodeA.y - cy)
    // -> A flat padding constant falls far short of nodeA's MAX_NODE_RADIUS: this only passes once
    //    the circle grows by each member's own radius.
    expect(clusterC.circle.r).toBeGreaterThan(distToNodeA + wrapper.vm.radiusFor(nodeA))
  })

  it("includes a nested folder node as a member of its parent folder's circle (OpenProject #3355)", async () => {
    const wrapper = await mountGraph()

    // -> `groupBy` defaults to 'folder', so the nested folder node and the page sitting directly
    //    in A both belong to the same 'A' circle.
    const pageA = wrapper.vm.nodes.find((node) => node.path === 'a')
    pageA.folder = 'A'
    pageA.x = 0
    pageA.y = 0

    const folderB = {
      path: 'A/B',
      locale: 'en',
      title: 'B',
      synthetic: true,
      x: 200,
      y: 0
    }
    wrapper.vm.nodes.push(folderB)

    wrapper.vm.computeClusters()

    const clusterA = wrapper.vm.clusters.find((c) => c.key === 'A')
    expect(clusterA).toBeDefined()
    // -> A centroid midway between the two x positions is what proves folderB counted as a member.
    expect(clusterA.circle.x).toBeCloseTo(100)
  })

  it("drawLabels draws a real node's label at the node's own center, not offset past its edge (OpenProject #2593)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 100
    nodeA.y = 100
    nodeB.x = 200
    nodeB.y = 200

    const radiusA = wrapper.vm.radiusFor(nodeA)
    const radiusB = wrapper.vm.radiusFor(nodeB)
    // -> The fixture's two nodes have different contributor counts, so their radii differ: a label
    //    drawn at the node center is distinguishable from one offset past the edge.
    expect(radiusA).not.toBe(radiusB)

    wrapper.vm.ctx.fillText.mockClear()
    // -> `Graph.vue`'s `MIN_NODE_RADIUS` is a `<script setup>`-local const with no export, so the
    //    `minRadius` argument is hardcoded to mirror it.
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 1.2, false, undefined, 20)

    const callA = wrapper.vm.ctx.fillText.mock.calls.find(([text]) => text === nodeA.title)
    expect(callA.slice(1)).toEqual([nodeA.x, nodeA.y])
    expect(callA[1]).not.toBe(nodeA.x + radiusA + LABEL_GAP)

    // -> Asserts the invariant over every drawn label rather than a count: whether the smaller node
    //    labels at all depends on the radius floor. `graphDraw.test.js` covers that cutoff.
    for (const [text, x, y] of wrapper.vm.ctx.fillText.mock.calls) {
      const node = wrapper.vm.nodes.find(
        (candidate) => (candidate.title ?? candidate.path) === text
      )
      // -> Synthetic hubs deliberately keep the outside placement, asserted separately below.
      if (node.synthetic) {
        continue
      }
      expect([x, y]).toEqual([node.x, node.y])
    }
  })

  it("drawLabels keeps a synthetic hub's label beside it, still offset by that node's own radius (OpenProject #2297, #2593)", async () => {
    const wrapper = await mountGraph()

    const synthetic = { path: 'docs', locale: 'en', synthetic: true, x: 40, y: 60, title: 'docs' }
    const radius = wrapper.vm.radiusFor(synthetic)

    wrapper.vm.ctx.fillText.mockClear()
    // -> `drawLabels()` ignores `minRadius` for synthetic nodes; it is passed anyway so the call
    //    stays at the full current signature.
    drawLabels(wrapper.vm.ctx, [synthetic], wrapper.vm.radiusFor, 1.2, false, undefined, 20)

    const [call] = wrapper.vm.ctx.fillText.mock.calls
    expect(call).toEqual(['docs', synthetic.x + radius + LABEL_GAP, synthetic.y])
  })
})
