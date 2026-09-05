import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2538: `applyFilters()`'s synthetic hub/folder/root nodes used to be freshly
 * constructed plain objects on every call, with no `x`/`y`, even for a marker that was already
 * visible and already settled -- which handed the node back to d3-force's origin-centered default
 * placement and produced a visible flash-jitter on every `activeFilters` change. The fix is an
 * identity cache (`Graph.vue`'s `syntheticNodeCache`, threaded through
 * `graphFilters.js#buildPathHierarchyEdges`) that reuses the same object -- and therefore whatever
 * position the simulation has since assigned it -- for a synthetic node whose id survives the call.
 * This suite asserts the identity/position survives a re-render that keeps the node visible, and
 * that it's correctly dropped on a wholesale `loadGraph()` reload.
 */
const FOLDER_FIXTURE_GRAPH = {
  nodes: [
    { path: 'guides/one', locale: 'en', title: 'One', icon: null, tags: [], folder: 'guides' },
    { path: 'guides/two', locale: 'en', title: 'Two', icon: null, tags: [], folder: 'guides' }
  ],
  edges: []
}

function findSynthetic(wrapper, path) {
  return wrapper.vm.nodes.find((n) => n.synthetic && n.path === path)
}

describe('Graph.vue synthetic node identity across activeFilters changes (OpenProject #2538)', () => {
  it('keeps the same synthetic folder node object across an activeFilters change that does not remove it', async () => {
    const wrapper = await mountGraph({ graph: FOLDER_FIXTURE_GRAPH })

    // -> Object identity is what actually determines the fix: `simulation.nodes()` (d3-force)
    //    only assigns a fresh default position to a node it's never seen before -- once identity
    //    survives, the running simulation's own forces carry the node's position forward smoothly
    //    from wherever it already was, rather than needing a literal frozen coordinate to prove it
    //    (the real simulation legitimately keeps ticking across the `await` below).
    const folderBefore = findSynthetic(wrapper, 'guides')
    expect(folderBefore).toBeTruthy()

    wrapper.vm.activeFilters.folderDepth = 5
    await flushPromises()

    expect(findSynthetic(wrapper, 'guides')).toBe(folderBefore)
  })

  it('keeps the same synthetic root node object across a folderDepth change', async () => {
    const wrapper = await mountGraph({ graph: FOLDER_FIXTURE_GRAPH })

    const rootBefore = findSynthetic(wrapper, '')
    expect(rootBefore).toBeTruthy()

    wrapper.vm.activeFilters.folderDepth = 5
    await flushPromises()

    expect(findSynthetic(wrapper, '')).toBe(rootBefore)
  })
})

describe('Graph.vue synthetic node cache reset on loadGraph() (OpenProject #2538)', () => {
  it('does not reuse a synthetic node object identity across a fresh loadGraph() fetch', async () => {
    const wrapper = await mountGraph({ graph: FOLDER_FIXTURE_GRAPH })

    const folderBefore = findSynthetic(wrapper, 'guides')
    expect(folderBefore).toBeTruthy()

    // -> A same-shape re-fetch (new site/keyword/sizeBy fetch, per `loadGraph()`'s own contract) is
    //    a wholesale new graph -- unlike the `activeFilters` cases above, this must NOT
    //    carry the previous synthetic node's identity forward, or a stale position from a previous
    //    fetch would leak into a graph that has nothing to do with it.
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FOLDER_FIXTURE_GRAPH) })
    await wrapper.vm.loadGraph()

    expect(findSynthetic(wrapper, 'guides')).not.toBe(folderBefore)
  })
})
