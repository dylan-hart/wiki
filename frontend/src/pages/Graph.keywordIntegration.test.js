import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_GRAPH, mountGraph } from './graphFixtures.js'

/**
 * Drives the real `<input>` through to the rendered highlight, never an intermediate
 * `wrapper.vm.<ref>`. `Graph.keywordSearch.test.js` (driving `keywordQuery`) and
 * `Graph.highlight.test.js` (driving `keywordMatches`) both stay green when the input, the fetch
 * and the render pass are each correct but never spliced together; only this suite catches that.
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

  /**
   * The debounced backend request is deliberately left unresolved, proving the synchronous
   * title-contains pass needs none. Asserting on the real canvas draw calls rather than only the
   * computed set is what catches a repaint watcher wired to `keywordMatches` alone.
   */
  it('a client-side title-only match repaints the real canvas, with no backend response at all (OpenProject #2533)', async () => {
    const wrapper = await mountGraph()
    const matchedNode = FIXTURE_GRAPH.nodes[0]

    wrapper.vm.ctx.arc.mockClear()
    const input = wrapper.find('.graph-view-filters input')
    await input.setValue(matchedNode.title.toLowerCase())
    // -> Timers deliberately not advanced past the debounce: the two calls asserted below are
    //    mountGraph()'s own setup fetches.
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.keywordMatches).toEqual([])
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set([`en:${matchedNode.path}`]))
    expect(wrapper.vm.ctx.arc).toHaveBeenCalled()
  })
})
