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
 * slider wiring yet (that's #2521's/#2525's own work packages and their own suite below).
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
    //    documents, which a caller (the depth control, #2525) must gate on `isLoading` rather than
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
 * OpenProject #2525 (Feature #2523's second task): the folder-depth control is a single-handle
 * `w-range` slider paired with an adjacent `w-input type="number"` field, captioned "Depth" -- not a
 * plain `<input type="range">`, and with no more "All"/unrestricted state at all. `activeFilters.
 * folderDepth` is always a concrete depth, defaulted to `actualMaxFolderDepth` once the graph loads
 * (functionally equivalent to the old "All" for the currently-loaded graph, per the WP's own spec),
 * clamped to `[0, actualMaxFolderDepth]` on every write via the shared `folderDepthSlider` bridge.
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

// -> One node nested well past MAX_DEPTH -- proves the control's own ceiling caps at MAX_DEPTH
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

describe('Graph.vue folder-depth control (OpenProject #2523/#2525)', () => {
  it('renders a single-handle w-range and an adjacent number field, captioned "Depth"', async () => {
    const wrapper = await mountGraph({
      messageOverrides: { 'graph.filters.folderDepth': 'xx-depth' }
    })

    const panel = wrapper.find('.graph-view-filters')
    expect(panel.text()).toContain('xx-depth')
    // -> w-range renders as `role="slider"` buttons, not a native `<input type="range">` any more.
    expect(panel.find('input[type="range"]').exists()).toBe(false)
    expect(panel.findAll('[role="slider"]')).toHaveLength(1)
    const numberField = panel.find('input[type="number"]')
    expect(numberField.exists()).toBe(true)
    expect(numberField.attributes('aria-label')).toBe('xx-depth')
  })

  it('defaults to the graph\'s own actual max depth once loaded, not an "All"/null sentinel', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    expect(wrapper.vm.actualMaxFolderDepth).toBe(2)
    expect(wrapper.vm.activeFilters.folderDepth).toBe(2)
    expect(wrapper.vm.folderDepthSlider).toBe(2)
  })

  it('defaults to 0 for a graph with no nested folders (max depth 0)', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH })

    expect(wrapper.vm.actualMaxFolderDepth).toBe(0)
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)
  })

  it('folderDepthSlider is a direct, clamped bridge to activeFilters.folderDepth', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.folderDepthSlider = 1
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(1)

    wrapper.vm.folderDepthSlider = 0
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)
  })

  it('setting activeFilters.folderDepth directly reads back through the slider getter too', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.activeFilters.folderDepth = 1
    await flushPromises()
    expect(wrapper.vm.folderDepthSlider).toBe(1)
  })

  it('clamps an out-of-range or non-numeric write to [0, actualMaxFolderDepth]', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.folderDepthSlider = 99
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(2)

    wrapper.vm.folderDepthSlider = -5
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)

    wrapper.vm.folderDepthSlider = Number.NaN
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)
  })

  it('caps at MAX_DEPTH even when the graph goes deeper', async () => {
    const wrapper = await mountGraph({ graph: OVER_MAX_DEPTH_GRAPH })

    expect(wrapper.vm.actualMaxFolderDepth).toBe(MAX_DEPTH)
    expect(wrapper.vm.activeFilters.folderDepth).toBe(MAX_DEPTH)
  })

  it("clearFilters() resets the depth back to the graph's own actual max depth", async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    wrapper.vm.folderDepthSlider = 0
    await flushPromises()
    expect(wrapper.vm.activeFilters.folderDepth).toBe(0)

    wrapper.vm.clearFilters()
    await flushPromises()

    expect(wrapper.vm.activeFilters.folderDepth).toBe(2)
    expect(wrapper.vm.folderDepthSlider).toBe(2)
  })

  it('"Clear filters" is hidden while the depth control sits at its default', async () => {
    const wrapper = await mountGraph({
      graph: NESTED_DEPTH_GRAPH,
      messageOverrides: { 'graph.filters.clear': 'xx-clear' }
    })

    expect(wrapper.text()).not.toContain('xx-clear')

    wrapper.vm.folderDepthSlider = 0
    await flushPromises()

    expect(wrapper.text()).toContain('xx-clear')
  })

  it('narrowing the depth control narrows the visible node set, same as the old control did', async () => {
    const wrapper = await mountGraph({ graph: NESTED_DEPTH_GRAPH })

    const nodesBefore = wrapper.vm.nodes.filter((n) => !n.synthetic)
    expect(nodesBefore).toHaveLength(3)

    // -> Depth 0 => only root-depth real pages ('docs') survive.
    wrapper.vm.folderDepthSlider = 0
    await flushPromises()

    const realNodesAfter = wrapper.vm.nodes.filter((n) => !n.synthetic)
    expect(realNodesAfter).toHaveLength(1)
    expect(realNodesAfter[0].path).toBe('docs')
  })
})
