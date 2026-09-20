import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountForPreview } from './headerSearchHarness.js'

/**
 * `?highlight=<query>` is what `Index.vue`'s `applyKeywordHighlight` pass reads on the destination
 * page -- the same convention the knowledge graph's click-through uses.
 */
describe('HeaderSearch result navigation highlight param', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('appends ?highlight=<query> to a result row link', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [{ path: 'foo/bar', title: 'Foo Bar', locale: 'en' }],
          totalHits: 1
        })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    const row = wrapper.find('.searchpanel-results .w-item')
    expect(row.attributes('href')).toBe('/foo/bar?highlight=ab')
  })

  it('URL-encodes a query with characters that are not URL-safe as-is', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo', locale: 'en' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('a&b c')
    await vi.advanceTimersByTimeAsync(400)

    const row = wrapper.find('.searchpanel-results .w-item')
    expect(row.attributes('href')).toBe('/foo?highlight=a%26b%20c')
  })

  it('trims surrounding whitespace out of the query before building the param', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo', locale: 'en' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('  ab  ')
    await vi.advanceTimersByTimeAsync(400)

    const row = wrapper.find('.searchpanel-results .w-item')
    expect(row.attributes('href')).toBe('/foo?highlight=ab')
  })
})
