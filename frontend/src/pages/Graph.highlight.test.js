import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/**
 * The render/highlight half of Feature #2414's keyword search (OpenProject #2480) -- distinct from
 * the existing `activeFilters` tests: a keyword match must never remove a node from `nodes.value`
 * (that's what would make it a filter), only change `highlightedNodeIds`. The keyword INPUT and its
 * wiring to `GET sites/:siteId/pages/search` are OpenProject #2478/#2479's own scope -- as of #2508,
 * `searchKeyword()` is what actually populates `keywordMatches` in production, but this suite still
 * drives it directly to isolate the highlight-computation half from the fetch/debounce half (which
 * `Graph.keywordSearch.test.js` and `Graph.keywordIntegration.test.js` cover on their own).
 */
describe('Graph.vue keyword highlight (OpenProject #2480)', () => {
  it('starts with no active highlight -- an empty keywordMatches yields an empty highlightedNodeIds', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.keywordMatches).toEqual([])
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('setting keywordMatches computes the matched nodes’ composite ids, without touching nodes.value', async () => {
    const wrapper = await mountGraph()
    const nodeCountBefore = wrapper.vm.nodes.length

    wrapper.vm.keywordMatches = [{ path: FIXTURE_GRAPH.nodes[0].path, locale: 'en' }]
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set([`en:${FIXTURE_GRAPH.nodes[0].path}`]))
    // -> Non-filtering: the visible node set is exactly what it was before the keyword matched.
    expect(wrapper.vm.nodes).toHaveLength(nodeCountBefore)
  })

  it('a match naming a page absent from the currently-loaded graph is a silent no-op, not a throw', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordMatches = [{ path: 'nowhere/in/graph', locale: 'en' }]
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:nowhere/in/graph']))
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('clearing keywordMatches clears highlightedNodeIds back to empty', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordMatches = [{ path: FIXTURE_GRAPH.nodes[0].path, locale: 'en' }]
    await flushPromises()
    expect(wrapper.vm.highlightedNodeIds.size).toBe(1)

    wrapper.vm.keywordMatches = []
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })
})
