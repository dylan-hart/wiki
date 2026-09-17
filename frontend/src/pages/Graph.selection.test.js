import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { useGraphStore } from '@/stores/graph'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #3363 (Feature #3362's "Graph canvas -- selected node" scope): a first click on a
 * node selects it (highlights via `selectedNodeId`, does not navigate); a second click on the
 * already-selected node navigates to that page; a click on a DIFFERENT node while one is already
 * selected re-selects the new node rather than navigating anywhere.
 *
 * OpenProject #3364 (corrected scope): the visible highlight lives on the nav sidebar's
 * corresponding row, not the canvas, so every selection change here is also asserted against
 * `useGraphStore().selectedPath` (the raw path `NavSidebarItem.vue#isSelected` reads) alongside
 * `selectedNodeId` (the composite id `onCanvasClick()`'s own click-toggle logic compares against).
 */
describe('Graph.vue selected-node interaction state (OpenProject #3363/#3364)', () => {
  it('a first click on a node selects it without navigating, and mirrors it into graphStore.selectedPath', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()

    expect(wrapper.vm.selectedNodeId).toBeNull()
    expect(graphStore.selectedPath).toBeNull()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })

    expect(wrapper.vm.selectedNodeId).toBe('en:a')
    expect(graphStore.selectedPath).toBe('a')
    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/')
  })

  /*
   * The simulation keeps running in real time between assertions (no fake timers here, same as
   * every other Graph.vue suite), so a node's x/y can drift a little between two clicks even with
   * no explicit repositioning in between -- re-pinning `fx`/`fy` right before the second click
   * (exactly what a real hover already does elsewhere in this file, see `Graph.hoverPin.test.js`)
   * keeps this test about the click sequence, not a race against the force layout.
   */
  it('a second click on the already-selected node navigates to it and clears the selection', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    nodeA.fx = 500
    nodeA.fy = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.selectedNodeId).toBe('en:a')
    expect(graphStore.selectedPath).toBe('a')

    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()
    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    await flushPromises()

    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')
    expect(wrapper.vm.selectedNodeId).toBeNull()
    expect(graphStore.selectedPath).toBeNull()
  })

  it('clicking a different node while one is selected re-selects instead of navigating', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 500
    nodeA.y = 500
    nodeA.fx = 500
    nodeA.fy = 500
    nodeB.x = -500
    nodeB.y = -500
    nodeB.fx = -500
    nodeB.fy = -500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.selectedNodeId).toBe('en:a')

    nodeB.x = -500
    nodeB.y = -500
    wrapper.vm.relayout()
    await wrapper.find('canvas').trigger('click', { clientX: -500, clientY: -500 })

    expect(wrapper.vm.selectedNodeId).toBe('en:b')
    expect(graphStore.selectedPath).toBe('b')
    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/')
  })

  it('a click that misses every node is a no-op and leaves any existing selection untouched', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    nodeA.fx = 500
    nodeA.fy = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    expect(wrapper.vm.selectedNodeId).toBe('en:a')

    // -> Far from every node: `findNodeAt` resolves to null, same miss case `navigateToNode` has
    //    always no-op'd on.
    await wrapper.find('canvas').trigger('click', { clientX: 0, clientY: 5000 })

    expect(wrapper.vm.selectedNodeId).toBe('en:a')
    expect(graphStore.selectedPath).toBe('a')
    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/')
  })

  it('clears graphStore.selectedPath on unmount so a stale selection never outlives the page', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    expect(graphStore.selectedPath).toBe('a')

    wrapper.unmount()

    expect(graphStore.selectedPath).toBeNull()
  })
})
