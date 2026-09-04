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
 * slider wiring yet (that's #2521's own work package and its own suite below).
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

/*
 * OpenProject #2521 (Feature #2514's scope): the folder-depth control is a slider, not a
 * `<w-input type="number">`, capped at `actualMaxFolderDepth` above (itself already capped at
 * `MAX_DEPTH`). `activeFilters.folderDepth == null` must still mean "no restriction"
 * (`graphFilters.js#computeVisibleSubset`), so the slider carries its own explicit leading "All"
 * position rather than defaulting to a real depth -- these tests exercise that position mapping
 * directly, plus the slider's own ceiling.
 */

// -> Nested two levels deep (`root` -> depth 0, `docs` -> depth 0, `docs/child` -> depth 1,
//    `docs/child/grandchild` -> depth 2), so `actualMaxFolderDepth` resolves to something other than
//    the trivial `0` FIXTURE_GRAPH itself would give.
const NESTED_DEPTH_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/child', locale: 'en', title: 'Child', icon: null, tags: [], folder: 'docs' },
    {
      path: 'docs/child/grandchild',
      locale: 'en',
      title: 'Grandchild',
      icon: null,
      tags: [],
      folder: 'docs/child'
    }
  ],
  edges: []
}

// -> One node nested well past MAX_DEPTH -- proves the slider's own ceiling caps at MAX_DEPTH
//    rather than offering every depth the graph actually reaches.
const OVER_MAX_DEPTH_GRAPH = {
  nodes: [
    {
      path: Array.from({ length: MAX_DEPTH + 5 }, (_, i) => `s${i}`).join('/'),
      locale: 'en',
      title: 'Deep',
      icon: null,
      tags: [],
      folder: 's0'
    }
  ],
  edges: []
}

describe('Graph.vue folder-depth slider (OpenProject #2520/#2521)', () => {
  it('renders a range input in the filter panel, captioned via graph.filters.folderDepth', async () => {
    const wrapper = await mountGraph({
      messageOverrides: { 'graph.filters.folderDepth': 'xx-folder-depth' }
    })

    const panel = wrapper.find('.graph-view-filters')
    expect(panel.text()).toContain('xx-folder-depth')
    const slider = panel.find('input[type="range"]')
    expect(slider.exists()).toBe(true)
    // -> Not a number input any more (OpenProject #2521's own scope decision).
    expect(panel.find('input[type="number"]').exists()).toBe(false)
  })

  it('defaults to the "All" position (folderDepth == null means no restriction)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: { 'graph.filters.folderDepthAll': 'xx-all' }
    })

    expect(wrapper.vm.activeFilters.folderDepth).toBe(null)
    expect(wrapper.vm.folderDepthSlider).toBe(0)
    expect(wrapper.vm.folderDepthSliderLabel).toBe('xx-all')
    expect(wrapper.find('.graph-view-filters').text()).toContain('xx-all')
  })

  it('maps slider position n (n >= 1) to folderDepth n - 1, and position 0 back to null', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.folderDepthSlider = 1
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)
    expect(wrapper.vm.folderDepthSliderLabel).toBe('0')

    wrapper.vm.folderDepthSlider = 3
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(2)
    expect(wrapper.vm.folderDepthSliderLabel).toBe('2')

    wrapper.vm.folderDepthSlider = 0
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(null)
  })

  it('setting activeFilters.folderDepth directly reads back through the slider getter too', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.activeFilters.folderDepth = 1
    await flushPromises()
    expect(wrapper.vm.folderDepthSlider).toBe(2)
  })

  it("caps the slider's range at the graph's own actual max folder depth", async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    // -> Real max depth is 2 (docs/child/grandchild); slider needs positions 0 ("All") through 3
    //    (depth 2), i.e. max position 3.
    expect(wrapper.vm.actualMaxFolderDepth).toBe(2)
    expect(wrapper.vm.folderDepthSliderMax).toBe(3)
  })

  it('caps the slider ceiling at MAX_DEPTH even when the graph goes deeper', async () => {
    const wrapper = await mountGraph({ graph: OVER_MAX_DEPTH_GRAPH })

    expect(wrapper.vm.actualMaxFolderDepth).toBe(MAX_DEPTH)
    expect(wrapper.vm.folderDepthSliderMax).toBe(MAX_DEPTH + 1)
  })

  it('resolves to a safe, non-negative range for the trivial (all root-level) default fixture', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH })

    expect(wrapper.vm.actualMaxFolderDepth).toBe(0)
    expect(wrapper.vm.folderDepthSliderMax).toBe(1)
  })

  it('clearFilters() resets the slider back to the "All" position', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.folderDepthSlider = 2
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(1)

    wrapper.vm.clearFilters()
    await flushPromises()

    expect(wrapper.vm.activeFilters.folderDepth).toBe(null)
    expect(wrapper.vm.folderDepthSlider).toBe(0)
  })

  it('moving the slider narrows the visible node set, same as the old number input did', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    const nodesBefore = wrapper.vm.nodes.filter((n) => !n.synthetic).length
    expect(nodesBefore).toBe(3)

    // -> Position 1 => folderDepth 0 => only root-depth real pages ('docs') survive.
    wrapper.vm.folderDepthSlider = 1
    await flushPromises()

    const realNodesAfter = wrapper.vm.nodes.filter((n) => !n.synthetic)
    expect(realNodesAfter).toHaveLength(1)
    expect(realNodesAfter[0].path).toBe('docs')
  })
})
