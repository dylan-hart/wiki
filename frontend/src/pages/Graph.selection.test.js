import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { useGraphStore } from '@/stores/graph'

import { mountGraph } from './graphFixtures.js'

/*
 * A canvas click carries no state of its own: a click on a real page node always navigates.
 * Selection is a sidebar concept (`composables/navSidebarDestination.js`), simulated here by
 * writing to `useGraphStore().selectedPath` the way a sidebar click would.
 */
describe('Graph.vue canvas clicks (OpenProject #3364, corrected scope)', () => {
  it('a single click on a real node navigates immediately, with no selection state created', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    await flushPromises()

    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')
    expect(graphStore.selectedPath).toBeNull()
  })

  it('a click that misses every node is a no-op', async () => {
    const wrapper = await mountGraph()

    await wrapper.find('canvas').trigger('click', { clientX: 0, clientY: 5000 })

    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/')
  })

  it('a second click on the same node navigates again -- there is no toggle to clear', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    nodeA.fx = 500
    nodeA.fy = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    await flushPromises()
    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')

    await wrapper.vm.$router.push('/_graph')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()
    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    await flushPromises()

    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')
  })
})

describe('Graph.vue selectedNodeId (OpenProject #3364, corrected scope)', () => {
  it('resolves to null with nothing selected', async () => {
    const wrapper = await mountGraph()
    expect(wrapper.vm.selectedNodeId).toBeNull()
  })

  it('resolves the composite id of the node matching the store-selected path and current locale', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()

    graphStore.select('a')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.selectedNodeId).toBe('en:a')
  })

  it('resolves to null when the selected path matches no currently-loaded node', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()

    graphStore.select('does-not-exist')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.selectedNodeId).toBeNull()
  })

  /*
   * Anchor trumps selected: a clicked empty folder anchors the graph on itself and sets
   * `selectedPath` to that same path. The sidebar marks nothing selected there, and the ring has to
   * agree or the two surfaces disagree about one state.
   */
  it('resolves to null when the selected path is also the current graph anchor', async () => {
    const wrapper = await mountGraph({ initialPath: '/_graph?path=a' })
    const graphStore = useGraphStore()

    graphStore.select('a')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.$route.query.path).toBe('a')
    expect(wrapper.vm.selectedNodeId).toBeNull()
  })

  it('clears on unmount, so a stale selection never outlives the page', async () => {
    const wrapper = await mountGraph()
    const graphStore = useGraphStore()

    graphStore.select('a')
    await wrapper.vm.$nextTick()
    expect(graphStore.selectedPath).toBe('a')

    wrapper.unmount()

    expect(graphStore.selectedPath).toBeNull()
  })
})
