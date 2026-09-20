import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * `findNodeAt()` backs both canvas click and hover, and scales each candidate's hit area with its
 * OWN rendered radius (`collideRadiusFor()`): a small node must not gain a hit area bigger than its
 * own circle just because some other node in the graph is huge.
 */
describe('Graph.vue findNodeAt (per-node hit radius, OpenProject #2748)', () => {
  it('hits a large node well outside the old flat 12px window', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> Push A to the top of the graph's own observed contributor range so it draws at
    //    MAX_NODE_RADIUS, pinning its radius to a known value.
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

    // -> 50px off-center: far outside any flat hit window, well inside A's own collide radius
    //    (radiusFor + 2).
    expect(wrapper.vm.findNodeAt(550, 500)).toBe(nodeA)
    expect(wrapper.vm.findNodeAt(500, 550)).toBe(nodeA)
  })

  it('does NOT hit a small node just outside its own (much smaller) radius, even within the old flat 12px window', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> B is the fixture's zero-contributor node, so it sits at the floor: MIN_NODE_RADIUS, and
    //    its own radius is therefore what decides the hit.
    nodeA.x = -500
    nodeA.y = -500
    nodeB.x = 0
    nodeB.y = 0
    wrapper.vm.relayout()

    expect(wrapper.vm.radiusFor(nodeB)).toBe(20)

    // -> 30px is outside B's own collide radius (radiusFor + 2) and outside every other node's at
    //    this distance; 8px is inside it.
    expect(wrapper.vm.findNodeAt(30, 0)).toBeNull()
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
    // -> Both circles genuinely contain (0, 0) -- A's ceiling radius from 100px away, B's floor
    //    radius from 5px -- so this is a real tie-break between two hits, not one candidate in range.
    nodeA.x = -100
    nodeA.y = 0
    nodeB.x = 5
    nodeB.y = 0
    wrapper.vm.relayout()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
    expect(wrapper.vm.radiusFor(nodeB)).toBe(20)
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
