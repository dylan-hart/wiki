import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/**
 * `keywordMatches` is set directly rather than through `searchKeyword()`, to isolate the
 * highlight computation from the fetch/debounce half `Graph.keywordSearch.test.js` covers.
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

/**
 * The client-side title-contains pass is unioned into the same `highlightedNodeIds` the backend
 * search populates; driving `keywordQuery` directly isolates it from the backend half.
 */
describe('Graph.vue client-side title-match highlight (OpenProject #2533)', () => {
  it('highlights a node whose title contains the query, with no backend match needed at all', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = FIXTURE_GRAPH.nodes[0].title.toLowerCase()
    await flushPromises()

    expect(wrapper.vm.keywordMatches).toEqual([])
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set([`en:${FIXTURE_GRAPH.nodes[0].path}`]))
  })

  it('unions the title-match set with whatever the backend search already matched, deduping shared ids', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordMatches = [{ path: 'nowhere/in/graph', locale: 'en' }]
    wrapper.vm.keywordQuery = FIXTURE_GRAPH.nodes[0].title.toLowerCase()
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(
      new Set(['en:nowhere/in/graph', `en:${FIXTURE_GRAPH.nodes[0].path}`])
    )
  })

  it('yields no title-driven highlight for an empty or whitespace-only query', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = '   '
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('clearing the query drops the title-driven highlight back to empty', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = FIXTURE_GRAPH.nodes[0].title.toLowerCase()
    await flushPromises()
    expect(wrapper.vm.highlightedNodeIds.size).toBe(1)

    wrapper.vm.keywordQuery = ''
    await flushPromises()

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })
})
