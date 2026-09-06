import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2748: `findNodeAt()` (the shared hit test behind both canvas click and hover) has to
 * scale each candidate's hit area with its OWN rendered radius (`collideRadiusFor()`), not one flat
 * constant -- a large node needs a proportionally large hit area, and a small node must not gain a
 * hit area bigger than its own circle just because some other node in the graph is huge.
 */
describe('Graph.vue findNodeAt (per-node hit radius, OpenProject #2748)', () => {
  it('hits a large node well outside the old flat 12px window', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> Push A to the top of the graph's own observed range so it draws at MAX_NODE_RADIUS (110,
    //    OpenProject #2561/#2594) -- same technique `Graph.layout.test.js`/`Graph.sizing.test.js`
    //    already use to pin a node's radius to a known value.
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)

    // -> 50px off-center is well past the old flat 12px hit radius, but comfortably inside A's own
    //    ~112px collide radius (radiusFor + 2).
    expect(wrapper.vm.findNodeAt(550, 500)).toBe(nodeA)
    expect(wrapper.vm.findNodeAt(500, 550)).toBe(nodeA)
  })

  it('does NOT hit a small node just outside its own (much smaller) radius, even within the old flat 12px window', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> B is the fixture's zero-contributor node, so it sits at the floor: MIN_NODE_RADIUS (10),
    //    collideRadiusFor === 12 (OpenProject #2594's doubled floor happens to land close to the old
    //    flat constant here -- the point of this test is the case where a node's OWN radius is what
    //    decides the hit, not that every node behaves identically to before).
    nodeA.x = -500
    nodeA.y = -500
    nodeB.x = 0
    nodeB.y = 0
    wrapper.vm.relayout()

    expect(wrapper.vm.radiusFor(nodeB)).toBe(10)

    // -> 20px away is outside B's own ~12px collide radius and outside every other node's radius at
    //    this distance from any of them, so nothing should be hit.
    expect(wrapper.vm.findNodeAt(20, 0)).toBeNull()
    // -> 8px away is inside B's own collide radius (12), so it IS hit.
    expect(wrapper.vm.findNodeAt(8, 0)).toBe(nodeB)
  })

  it('picks the nearest of two overlapping candidates', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }
    // -> A's huge (110px) radius reaches all the way to the click point at (0, 0) from 100px away,
    //    and B's own floor (10px) radius also reaches it from 5px away -- both circles genuinely
    //    contain the click point, so this is a real tie-break between two hits, not just "only one
    //    candidate was ever in range". B is the nearer of the two.
    nodeA.x = -100
    nodeA.y = 0
    nodeB.x = 5
    nodeB.y = 0
    wrapper.vm.relayout()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
    expect(wrapper.vm.radiusFor(nodeB)).toBe(10)
    expect(wrapper.vm.findNodeAt(0, 0)).toBe(nodeB)
  })

  it('returns null with no quadtree built yet', async () => {
    const wrapper = await mountGraph()
    wrapper.vm.nodeQuadtree = null

    expect(wrapper.vm.findNodeAt(0, 0)).toBeNull()
  })

  it('backs both the click and hover handlers, so hover also gets the scaled hit area', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 550, clientY: 500 })

    expect(wrapper.vm.hoveredNode).toBe(nodeA)
  })
})
