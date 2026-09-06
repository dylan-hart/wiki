import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2479 (wiring `keywordQuery` to `GET /sites/:siteId/pages/search`, the same
 * full-text search the header search bar uses) as unified by OpenProject #2508: this suite used to
 * drive a since-deleted `graphKeyword` ref and assert against a since-deleted `keywordMatchIds`
 * Set -- neither was actually reachable from the real `keywordQuery` input or `highlightedNodeIds`
 * render output, which is exactly the bug #2508 fixed. It now drives `wrapper.vm.keywordQuery`
 * directly (the same ref the `w-input` at `.graph-view-filters input` binds to -- see
 * `Graph.filters.test.js` for the input-binding half) and asserts against `keywordMatches`/
 * `highlightedNodeIds`, the real refs the fetch populates and the render pass reads. See
 * `Graph.keywordIntegration.test.js` for the end-to-end version driving the actual `<input>` element.
 */
describe('Graph.vue keyword search wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no keyword and no matches', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.keywordQuery).toBe('')
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('does not fetch while the keyword is empty or whitespace-only', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = '   '
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2) // -> graph + pageviews, from mountGraph() alone
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('debounces the fetch -- not fired until the debounce window elapses', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    wrapper.vm.keywordQuery = 'a'
    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)
  })

  it("queries the same pages/search endpoint the header search uses, with the endpoint's own max limit", async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    wrapper.vm.keywordQuery = 'docs'
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'docs', limit: 100 }
    })
  })

  it('populates keywordMatches with the raw results, and highlightedNodeIds with their composite ids', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [
            { path: 'a', locale: 'en', title: 'A' },
            { path: 'guides/deep', locale: 'en', title: 'Deep' }
          ],
          totalHits: 2
        })
    })

    wrapper.vm.keywordQuery = 'a'
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.keywordMatches).toEqual([
      { path: 'a', locale: 'en', title: 'A' },
      { path: 'guides/deep', locale: 'en', title: 'Deep' }
    ])
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:a', 'en:guides/deep']))
  })

  it('trims the keyword before both the empty-check and the request', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'a', locale: 'en' }], totalHits: 1 })
    })

    wrapper.vm.keywordQuery = '  a  '
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'a', limit: 100 }
    })
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:a']))
  })

  it('clearing the keyword resets matches synchronously and cancels a pending fetch', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'a', locale: 'en' }], totalHits: 1 })
    })
    wrapper.vm.keywordQuery = 'a'
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:a']))

    wrapper.vm.keywordQuery = 'ab'
    wrapper.vm.keywordQuery = ''
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(3) // -> graph + pageviews + the one settled 'a' fetch
    expect(wrapper.vm.keywordMatches).toEqual([])
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set())
  })

  it('drops a stale response that resolves after a newer one', async () => {
    const wrapper = await mountGraph()
    let resolveFirst
    let resolveSecond
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve
    })
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => firstPromise })
      .mockReturnValueOnce({ json: () => secondPromise })

    wrapper.vm.keywordQuery = 'ab'
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)

    wrapper.vm.keywordQuery = 'abc'
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(4)

    // -> Out-of-order: the newer ("abc") request settles first, the stale ("ab") one lands after
    resolveSecond({ results: [{ path: 'abc-page', locale: 'en' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)
    resolveFirst({ results: [{ path: 'ab-page', locale: 'en' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:abc-page']))
  })

  it('degrades keywordMatches to empty (not stale) on a failed request, quietly -- but a client-side title match survives it (OpenProject #2533)', async () => {
    const wrapper = await mountGraph()
    // -> `Graph.vue` logs the failure through `helpers/log.js` (OpenProject #2682), which
    //    reaches `console.warn` under `import.meta.env.DEV` -- true here, so the spy still sees it
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network down'))
    })

    wrapper.vm.keywordQuery = 'a'
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.keywordMatches).toEqual([])
    // -> The BACKEND half of the match set degrades to empty on failure, but the client-side
    //    title-contains pass (#2533) is independent of the backend request entirely -- fixture node
    //    'a' is titled 'A', which the query 'a' matches case-insensitively regardless of whether the
    //    search request succeeded, failed, or is still in flight.
    expect(wrapper.vm.highlightedNodeIds).toEqual(new Set(['en:a']))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('cancels the pending debounced fetch on unmount', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = 'a'
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2) // -> only the mountGraph() graph + pageviews calls
  })

  it('a keyword change does not re-run the visible-node filtering pipeline', async () => {
    // -> Keyword search highlights, it doesn't filter (Feature #2414's own scope decision) -- proven
    //    here by asserting the node/edge sets are untouched by a keyword change, unlike a real
    //    `activeFilters` change (see `Graph.rendering.test.js`/`graphFilters.test.js` for that half).
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })
    const nodesBefore = wrapper.vm.nodes
    const edgesBefore = wrapper.vm.edges

    wrapper.vm.keywordQuery = 'a'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(wrapper.vm.nodes).toBe(nodesBefore)
    expect(wrapper.vm.edges).toBe(edgesBefore)
  })
})
