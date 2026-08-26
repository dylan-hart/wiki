import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetSiteIdCache, getSiteId } from './site.js'

/*
 * OpenProject #1981: `getSiteId()`'s whole point is the module-level `siteIdPromise` cache -- one
 * `/_api/sites/current` request per page load, shared by every block instance that asks, the same
 * pattern `./config.js`'s `fetchSite` uses. These tests lock down the cache's two promises: that
 * concurrent callers truly share one in-flight request, and that a failed request doesn't wedge the
 * cache shut for the rest of the page's life.
 */
describe('shared/site.js: getSiteId()', () => {
  beforeEach(() => {
    // -> The module-level cache is deliberate in production but would otherwise leak one test's
    //    mocked response (or its call count) into the next -- same reason config.test.js resets it.
    _resetSiteIdCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('issues exactly one fetch for many concurrent callers, all resolving to the same id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'site-1' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.all([getSiteId(), getSiteId(), getSiteId()])

    expect(results).toEqual(['site-1', 'site-1', 'site-1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves to null when the request fails, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    expect(await getSiteId()).toBe(null)
  })

  it('does not permanently poison the cache after a failed fetch -- a later call retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'site-1' })
      })
    vi.stubGlobal('fetch', fetchMock)

    expect(await getSiteId()).toBe(null)
    expect(await getSiteId()).toBe('site-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resolves to null for a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ id: 'site-1' })
      })
    )

    expect(await getSiteId()).toBe(null)
  })
})
