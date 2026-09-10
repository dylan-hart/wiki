import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2924: hovering a node pins its `fx`/`fy` to its current position (freezing it
 * against the simulation for the hovered duration), and un-hovering -- whether onto empty canvas
 * or straight onto a different node -- clears the previously-hovered node's `fx`/`fy` back to
 * `null` so it rejoins the simulation. The existing `applyHoverPushImpulse` outward-push behavior
 * on other nodes (OpenProject #2748's own `Graph.hitTest.test.js` covers the underlying hit test)
 * must keep working unchanged alongside the pin. OpenProject #2931 adds the third release path:
 * the pointer leaving the canvas element entirely, where no further `mousemove` can fire.
 */
describe('Graph.vue hover pin (OpenProject #2924)', () => {
  it('pins the hovered node fx/fy to its current x/y on hover start', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    expect(nodeA.fx == null).toBe(true)
    expect(nodeA.fy == null).toBe(true)

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })

    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(nodeA.x)
    expect(nodeA.fy).toBe(nodeA.y)
  })

  it('clears fx/fy back to null on hover-end (moving onto empty canvas)', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(500)
    expect(nodeA.fy).toBe(500)

    // -> Far from every node: `findNodeAt` resolves to null, which is the hover-end case.
    await wrapper.find('canvas').trigger('mousemove', { clientX: 0, clientY: 5000 })

    expect(wrapper.vm.hoveredNode).toBeNull()
    expect(nodeA.fx).toBeNull()
    expect(nodeA.fy).toBeNull()
  })

  it('clears the old node and pins the new one when hover moves directly between two nodes', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(500)

    await wrapper.find('canvas').trigger('mousemove', { clientX: -500, clientY: -500 })

    expect(wrapper.vm.hoveredNode).toBe(nodeB)
    expect(nodeA.fx).toBeNull()
    expect(nodeA.fy).toBeNull()
    expect(nodeB.fx).toBe(-500)
    expect(nodeB.fy).toBe(-500)
  })

  it('releases the pinned node when the pointer leaves the canvas entirely (OpenProject #2931)', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(500)
    expect(nodeA.fy).toBe(500)

    // -> The pointer exits the canvas element's bounds while still over the node: no further
    //    `mousemove` fires on the canvas, so `mouseleave` is the only event that can release it.
    await wrapper.find('canvas').trigger('mouseleave')

    expect(wrapper.vm.hoveredNode).toBeNull()
    expect(nodeA.fx).toBeNull()
    expect(nodeA.fy).toBeNull()
    expect(wrapper.find('canvas').classes()).not.toContain('graph-view-canvas--hover')
  })

  it('treats mouseleave with nothing hovered as a no-op', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()

    expect(wrapper.vm.hoveredNode).toBeNull()
    await wrapper.find('canvas').trigger('mouseleave')

    expect(wrapper.vm.hoveredNode).toBeNull()
    expect(nodeA.fx == null).toBe(true)
    expect(nodeA.fy == null).toBe(true)
  })

  it('still applies the existing hover push impulse to other nodes alongside the pin', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    nodeB.vx = 0
    nodeB.vy = 0
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })

    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(500)
    // -> The pushed-away node's velocity is nudged away from the hovered node -- it is not itself
    //    pinned, only nudged, so its fx/fy stay unset.
    expect(nodeB.fx == null).toBe(true)
    expect(nodeB.fy == null).toBe(true)
    expect(nodeB.vx !== 0 || nodeB.vy !== 0).toBe(true)
  })

  it('does not re-run the pin/unpin work while the mouse stays over the same node', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })
    expect(nodeA.fx).toBe(500)

    // -> Move `nodeA` (as the simulation would between ticks) and re-hover the SAME point/node --
    //    the pin must not be refreshed to the new x/y, since the no-op guard on an unchanged
    //    hover target skips the whole branch.
    nodeA.x = 501
    nodeA.y = 501
    await wrapper.find('canvas').trigger('mousemove', { clientX: 500, clientY: 500 })

    expect(wrapper.vm.hoveredNode).toBe(nodeA)
    expect(nodeA.fx).toBe(500)
    expect(nodeA.fy).toBe(500)
  })
})
