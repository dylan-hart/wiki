import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetSiteIdCache,
  getCurrentPage,
  getCurrentPageAccess,
  getSiteId,
  getSiteLocales
} from './site.js'

const SITE_ID = '11111111-1111-4111-8111-111111111111'

function stubFetch(handler) {
  const fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('shared/site.js', () => {
  beforeEach(() => {
    _resetSiteIdCache()
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.pushState({}, '', '/')
  })

  describe('getSiteId', () => {
    it('issues exactly one fetch for N concurrent callers, all resolving to the same id', async () => {
      const fetchMock = stubFetch(async () => ({ ok: true, json: async () => ({ id: SITE_ID }) }))

      const results = await Promise.all([getSiteId(), getSiteId(), getSiteId()])

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('/_api/sites/current')
      expect(results).toEqual([SITE_ID, SITE_ID, SITE_ID])
    })

    it('resolves to null, without throwing, when the response is not ok', async () => {
      stubFetch(async () => ({ ok: false, json: async () => null }))
      expect(await getSiteId()).toBeNull()
    })

    it('resolves to null, without throwing, when the request itself rejects', async () => {
      stubFetch(async () => {
        throw new Error('network down')
      })
      expect(await getSiteId()).toBeNull()
    })

    it('caches a failed fetch too -- one attempt per page load, not a retry on every call', async () => {
      const fetchMock = stubFetch(async () => ({ ok: false, json: async () => null }))

      expect(await getSiteId()).toBeNull()
      expect(await getSiteId()).toBeNull()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not permanently poison the cache after a request that rejects -- a later call retries', async () => {
      // OpenProject #1981: a rejected fetch (offline, a dropped connection) is transient in a way a
      // well-formed non-ok response is not, so it must not wedge the cache shut for the rest of the
      // page's life the way the "caches a failed fetch too" case above deliberately does.
      const fetchMock = stubFetch(
        vi
          .fn()
          .mockRejectedValueOnce(new Error('network down'))
          .mockResolvedValueOnce({ ok: true, json: async () => ({ id: SITE_ID }) })
      )

      expect(await getSiteId()).toBeNull()
      expect(await getSiteId()).toBe(SITE_ID)

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('issues a fresh request after _resetSiteIdCache', async () => {
      const fetchMock = stubFetch(async () => ({ ok: true, json: async () => ({ id: SITE_ID }) }))

      await getSiteId()
      _resetSiteIdCache()
      await getSiteId()

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('getSiteLocales', () => {
    it("returns the site's locale config", async () => {
      const locales = { primary: 'en', active: ['en', 'fr'], forcePrefix: false }
      stubFetch(async () => ({ ok: true, json: async () => ({ id: SITE_ID, locales }) }))

      expect(await getSiteLocales()).toEqual(locales)
    })

    it('returns null when the site could not be resolved', async () => {
      stubFetch(async () => ({ ok: false, json: async () => null }))
      expect(await getSiteLocales()).toBeNull()
    })
  })

  describe('getCurrentPage', () => {
    it('falls back to the primary locale for an unprefixed path', async () => {
      window.history.pushState({}, '', '/docs/intro')
      stubFetch(async () => ({
        ok: true,
        json: async () => ({ id: SITE_ID, locales: { primary: 'en', active: ['en', 'fr'] } })
      }))

      expect(await getCurrentPage()).toEqual({ locale: 'en', path: 'docs/intro' })
    })

    it('reads a recognized leading locale segment as the locale, stripped from the path', async () => {
      window.history.pushState({}, '', '/fr/docs/intro')
      stubFetch(async () => ({
        ok: true,
        json: async () => ({ id: SITE_ID, locales: { primary: 'en', active: ['en', 'fr'] } })
      }))

      expect(await getCurrentPage()).toEqual({ locale: 'fr', path: 'docs/intro' })
    })

    it("does not mistake an ordinary path's first segment for a locale it isn't", async () => {
      window.history.pushState({}, '', '/de/docs/intro')
      stubFetch(async () => ({
        ok: true,
        json: async () => ({ id: SITE_ID, locales: { primary: 'en', active: ['en', 'fr'] } })
      }))

      expect(await getCurrentPage()).toEqual({ locale: 'en', path: 'de/docs/intro' })
    })

    it('matches a locale segment case-insensitively', async () => {
      window.history.pushState({}, '', '/FR/docs/intro')
      stubFetch(async () => ({
        ok: true,
        json: async () => ({ id: SITE_ID, locales: { primary: 'en', active: ['en', 'fr'] } })
      }))

      expect(await getCurrentPage()).toEqual({ locale: 'fr', path: 'docs/intro' })
    })

    it('reads the site root as an empty path', async () => {
      window.history.pushState({}, '', '/')
      stubFetch(async () => ({
        ok: true,
        json: async () => ({ id: SITE_ID, locales: { primary: 'en', active: ['en'] } })
      }))

      expect(await getCurrentPage()).toEqual({ locale: 'en', path: '' })
    })
  })

  describe('getCurrentPageAccess', () => {
    it("resolves the page's id and this reader's page-rule permissions off the public page-by-hash route", async () => {
      window.history.pushState({}, '', '/docs/intro')
      const fetchMock = stubFetch(async (url) => {
        if (url === '/_api/sites/current') {
          return { ok: true, json: async () => ({ id: SITE_ID, locales: { primary: 'en' } }) }
        }
        return {
          ok: true,
          json: async () => ({
            id: 'page-1',
            viewer: { permissions: ['read:pages', 'write:pages'] }
          })
        }
      })

      const result = await getCurrentPageAccess()

      expect(result).toEqual({
        siteId: SITE_ID,
        pageId: 'page-1',
        permissions: ['read:pages', 'write:pages']
      })
      const [pageUrl] = fetchMock.mock.calls.find(([url]) => url !== '/_api/sites/current')
      expect(pageUrl).toMatch(new RegExp(`^/_api/sites/${SITE_ID}/pages/[0-9a-f]+\\?`))
    })

    it('fails closed with no page fetch at all when the site cannot be resolved', async () => {
      const fetchMock = stubFetch(async () => ({ ok: false, json: async () => null }))

      expect(await getCurrentPageAccess()).toEqual({ siteId: null, pageId: null, permissions: [] })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('fails closed when the page lookup itself fails', async () => {
      stubFetch(async (url) =>
        url === '/_api/sites/current'
          ? { ok: true, json: async () => ({ id: SITE_ID, locales: { primary: 'en' } }) }
          : { ok: false, json: async () => null }
      )

      expect(await getCurrentPageAccess()).toEqual({
        siteId: SITE_ID,
        pageId: null,
        permissions: []
      })
    })
  })
})
