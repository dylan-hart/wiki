import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/**
 * OpenProject #2508: a real end-to-end regression test for the keyword-search chain, exercising the
 * actual bound `<input>` element (OpenProject #2478) all the way through to the rendered highlight
 * (OpenProject #2480) -- not `wrapper.vm.<ref> = ...` on any intermediate ref. This is deliberately
 * NOT a copy of `Graph.keywordSearch.test.js` (which drives `keywordQuery` directly) or
 * `Graph.highlight.test.js` (which drives `keywordMatches` directly): each of those, on its own,
 * would have stayed green throughout the whole time this feature was broken -- #2478/#2479/#2480
 * each shipped with fully passing isolated tests, and the three pieces were still never spliced
 * together. Only a test that drives the real input and asserts on the real render output can catch
 * that class of gap, which is exactly what this suite is for.
 */
describe('Graph.vue keyword search integration (OpenProject #2508)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('typing into the real keyword input highlights the matching node, end to end', async () => {
    const wrapper = await mountGraph()
    const matchedPath = FIXTURE_GRAPH.nodes[0].path
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [{ path: matchedPath, locale: 'en', title: FIXTURE_GRAPH.nodes[0].title }],
          totalHits: 1
        })
    })

    const input = wrapper.find('.graph-view-filters input')
    expect(input.exists()).toBe(true)

    await input.setValue('a')
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'a', limit: 100 }
    })
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set([`en:${matchedPath}`]))
  })

  it('clearing the real input via the clearable affordance drops the highlight', async () => {
    const wrapper = await mountGraph()
    const matchedPath = FIXTURE_GRAPH.nodes[0].path
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [{ path: matchedPath, locale: 'en' }],
          totalHits: 1
        })
    })

    const input = wrapper.find('.graph-view-filters input')
    await input.setValue('a')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.vm.highlightedNodeIds.size).toBe(1)

    await input.setValue('')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('a keyword the loaded graph has no page for highlights nothing, without breaking the input', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    const input = wrapper.find('.graph-view-filters input')
    await input.setValue('nonexistent-keyword')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})
