import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2479: wiring the graph's keyword input to `GET /sites/:siteId/pages/search`, the
 * same full-text search the header search bar uses. `#2478` (the actual `w-input` control) and
 * `#2480` (highlighting matches in the render pass) are separate Tasks -- this suite drives
 * `wrapper.vm.graphKeyword` directly, exactly as a future bound `w-input` would, and asserts
 * against `wrapper.vm.keywordMatchIds`, the composite-id Set `#2480`'s render pass will read.
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

    expect(wrapper.vm.graphKeyword).toBe('')
    expect(wrapper.vm.keywordMatchIds).toEqual(new Set())
  })

  it('does not fetch while the keyword is empty or whitespace-only', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.graphKeyword = '   '
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2) // -> graph + pageviews, from mountGraph() alone
    expect(wrapper.vm.keywordMatchIds).toEqual(new Set())
  })

  it('debounces the fetch -- not fired until the debounce window elapses', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    wrapper.vm.graphKeyword = 'a'
    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)
  })

  it("queries the same pages/search endpoint the header search uses, with the endpoint's own max limit", async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    wrapper.vm.graphKeyword = 'docs'
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'docs', limit: 100 }
    })
  })

  it('populates keywordMatchIds with the composite locale:path id of every result', async () => {
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

    wrapper.vm.graphKeyword = 'a'
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.keywordMatchIds).toEqual(new Set(['en:a', 'en:guides/deep']))
  })

  it('trims the keyword before both the empty-check and the request', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'a', locale: 'en' }], totalHits: 1 })
    })

    wrapper.vm.graphKeyword = '  a  '
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'a', limit: 100 }
    })
    expect(wrapper.vm.keywordMatchIds).toEqual(new Set(['en:a']))
  })

  it('clearing the keyword resets matches synchronously and cancels a pending fetch', async () => {
    const wrapper = await mountGraph()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'a', locale: 'en' }], totalHits: 1 })
    })
    wrapper.vm.graphKeyword = 'a'
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.vm.keywordMatchIds).toEqual(new Set(['en:a']))

    wrapper.vm.graphKeyword = 'ab'
    wrapper.vm.graphKeyword = ''
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(3) // -> graph + pageviews + the one settled 'a' fetch
    expect(wrapper.vm.keywordMatchIds).toEqual(new Set())
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

    wrapper.vm.graphKeyword = 'ab'
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(3)

    wrapper.vm.graphKeyword = 'abc'
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(4)

    // -> Out-of-order: the newer ("abc") request settles first, the stale ("ab") one lands after
    resolveSecond({ results: [{ path: 'abc-page', locale: 'en' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)
    resolveFirst({ results: [{ path: 'ab-page', locale: 'en' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(wrapper.vm.keywordMatchIds).toEqual(new Set(['en:abc-page']))
  })

  it('degrades to an empty (not stale) match set on a failed request, quietly', async () => {
    const wrapper = await mountGraph()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network down'))
    })

    wrapper.vm.graphKeyword = 'a'
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.keywordMatchIds).toEqual(new Set())
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('cancels the pending debounced fetch on unmount', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.graphKeyword = 'a'
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

    wrapper.vm.graphKeyword = 'a'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(wrapper.vm.nodes).toBe(nodesBefore)
    expect(wrapper.vm.edges).toBe(edgesBefore)
  })
})
