import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { useGraphStore } from '@/stores/graph'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #3364 (corrected scope): a graph canvas click has no state of its own -- a single
 * click on a real page node always navigates, full stop, exactly as it did before OpenProject
 * #3363's now-reverted two-click select/navigate toggle ever existed. Selection is a SIDEBAR
 * concept (`composables/navSidebarDestination.js`), simulated here by writing directly to
 * `useGraphStore().selectedPath` the same way a sidebar click would.
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

    // -> Simulate returning to the graph and clicking the very same node again: still a plain,
    //    immediate navigation, not a "second click" of anything.
    await wrapper.vm.$router.push('/_graph')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()
    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })
    await flushPromises()

    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')
  })
})

/*
 * `selectedNodeId` resolves `useGraphStore().selectedPath` (set by a sidebar click, simulated here
 * directly) plus the current locale into the composite id `graphDraw.js#drawNodes` rings -- the same
 * resolution shape `applyRouteFocus()` already does for the anchor, just off the store instead of
 * `route.query.path`.
 */
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
   * Anchor trumps selected (OpenProject #3364/#3365's shared product rule, `isSelected()`'s own doc
   * comment): a clicked EMPTY folder anchors the graph on itself, which also happens to set
   * `selectedPath` to that identical path. The sidebar deliberately shows nothing as "selected" in
   * that case, and the graph ring must agree -- ringing a node here that the sidebar isn't marking
   * selected would be two surfaces disagreeing about the same state.
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
