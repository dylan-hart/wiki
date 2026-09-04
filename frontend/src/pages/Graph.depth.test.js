import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithApp } from '../../test/mount.js'
import { createTestRouter } from '../../test/router.js'
import Graph from './Graph.vue'
import { MAX_DEPTH } from './graphFilters.js'
import { FIXTURE_GRAPH, GRAPH_MESSAGES, mountGraph, NESTED_FIXTURE_GRAPH } from './graphFixtures.js'

/*
 * OpenProject #2514/#2520 (Feature #2514's first task): the `actualMaxFolderDepth` computed that
 * mirrors `backend/models/tree.ts#MAX_DEPTH` on the frontend and derives the deepest folder actually
 * present in the currently loaded graph. This is deliberately script-only coverage -- no template or
 * slider wiring yet (that's #2521's own work package and its own suite).
 */
describe('Graph.vue actualMaxFolderDepth (OpenProject #2520)', () => {
  it('is 0 for a graph with no nested folders (FIXTURE_GRAPH: root-level pages only)', async () => {
    const wrapper = await mountGraph()
    expect(wrapper.vm.actualMaxFolderDepth).toBe(0)
  })

  it('reflects the deepest folder actually present in a nested graph', async () => {
    const wrapper = await mountGraph({ graph: NESTED_FIXTURE_GRAPH })
    expect(wrapper.vm.actualMaxFolderDepth).toBe(1)
  })

  it('derives from allNodes (the full loaded graph), not the currently-filtered nodes', async () => {
    const wrapper = await mountGraph({ graph: NESTED_FIXTURE_GRAPH })

    // -> Narrowing the tag filter to something no node matches empties `nodes.value` (the
    //    currently-visible subset) without touching `allNodes.value` -- `actualMaxFolderDepth` must
    //    not shrink along with it, same "narrowing one filter shouldn't shrink another's own range"
    //    reasoning `tagOptions`/`localeOptions` already rely on.
    wrapper.vm.activeFilters.tags = ['nonexistent-tag']
    await flushPromises()

    expect(wrapper.vm.nodes.length).toBe(0)
    expect(wrapper.vm.actualMaxFolderDepth).toBe(1)
  })

  it('caps at MAX_DEPTH for a graph deeper than the reasonable ceiling', async () => {
    const deepPath = Array.from({ length: MAX_DEPTH + 5 }, (_, i) => `level${i}`).join('/')
    const deepGraph = {
      nodes: [{ path: deepPath, locale: 'en', title: 'Deep', icon: null, tags: [], folder: '' }],
      edges: []
    }

    const wrapper = await mountGraph({ graph: deepGraph })
    expect(wrapper.vm.actualMaxFolderDepth).toBe(MAX_DEPTH)
  })

  it('reads 0 before the initial graph fetch resolves, same as an empty allNodes', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])
    // -> Never resolved within this test, so `loadGraph()`'s fetch stays in flight and
    //    `allNodes.value` stays `[]` -- the pre-load state `actualMaxFolderDepth`'s own doc comment
    //    documents, which a caller (the depth slider, #2521) must gate on `isLoading` rather than
    //    trust as a real depth-0 graph.
    API_CLIENT.get.mockReturnValueOnce({ json: () => new Promise(() => {}) })

    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })

    expect(wrapper.vm.isLoading).toBe(true)
    expect(wrapper.vm.actualMaxFolderDepth).toBe(0)
  })

  it('is capped correctly once loaded, even after starting from the pre-load 0', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH })
    expect(wrapper.vm.isLoading).toBe(false)
    expect(wrapper.vm.actualMaxFolderDepth).toBe(0)
  })
})
