import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * d3-force gives any node object it has not seen before an origin-centered default position, so
 * rebuilding the synthetic hub/folder/root nodes on every `applyFilters()` call flashes them back
 * to the middle. `Graph.vue`'s `syntheticNodeCache` reuses the object, and the position the
 * simulation has since given it, for every synthetic id that survives the call.
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

    // -> Identity, not a frozen coordinate, is what can be asserted: the real simulation
    //    legitimately keeps ticking across the `await` below.
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

    // -> A re-fetch is a wholesale new graph, so unlike the `activeFilters` cases above identity
    //    must NOT carry forward: a stale position would leak into an unrelated graph.
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FOLDER_FIXTURE_GRAPH) })
    await wrapper.vm.loadGraph()

    expect(findSynthetic(wrapper, 'guides')).not.toBe(folderBefore)
  })
})
