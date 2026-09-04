import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { MAX_DEPTH } from './graphFilters.js'
import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2521 (Feature #2514's scope): the folder-depth control is a slider, not a
 * `<w-input type="number">`, capped at `min(actual graph depth, MAX_DEPTH)`. `activeFilters.
 * folderDepth == null` must still mean "no restriction" (`graphFilters.js#computeVisibleSubset`),
 * so the slider carries its own explicit leading "All" position rather than defaulting to a real
 * depth -- these tests exercise that position mapping directly, plus the depth ceiling itself
 * (OpenProject #2520's `deriveMaxFolderDepth`/`MAX_DEPTH`, consumed here).
 */

// -> Nested two levels deep (`root` -> depth 0, `docs` -> depth 0, `docs/child` -> depth 1,
//    `docs/child/grandchild` -> depth 2), so `graphMaxFolderDepth` resolves to something other than
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
    expect(wrapper.vm.graphMaxFolderDepth).toBe(2)
    expect(wrapper.vm.folderDepthSliderMax).toBe(3)
  })

  it('caps the slider ceiling at MAX_DEPTH even when the graph goes deeper', async () => {
    const wrapper = await mountGraph({ graph: OVER_MAX_DEPTH_GRAPH })

    expect(wrapper.vm.graphMaxFolderDepth).toBe(MAX_DEPTH)
    expect(wrapper.vm.folderDepthSliderMax).toBe(MAX_DEPTH + 1)
  })

  it('resolves to a safe, non-negative range for the trivial (all root-level) default fixture', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH })

    expect(wrapper.vm.graphMaxFolderDepth).toBe(0)
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
