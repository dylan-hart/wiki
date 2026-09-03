import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useSiteStore } from './site.js'
import { pagePathHash } from '@/helpers/pagePaths'
import { stubPageResponse } from './pageStoreFixtures.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('page store: viewer.activeEditors (task 546)', () => {
  it('applyViewerState() carries activeEditors onto the store as-is', () => {
    const pageStore = usePageStore()

    pageStore.applyViewerState({
      permissions: [],
      isWatching: false,
      activeEditors: { count: 2, names: ['Ada Lovelace', 'Grace Hopper'] }
    })

    expect(pageStore.activeEditors).toEqual({ count: 2, names: ['Ada Lovelace', 'Grace Hopper'] })
  })

  it('applyViewerState() defaults to zero when the server omits activeEditors', () => {
    const pageStore = usePageStore()
    // -> Not a real response shape (the route always sends it), but the same defensive fallback
    //    every other viewer field gets here
    pageStore.applyViewerState({ permissions: [] })

    expect(pageStore.activeEditors).toEqual({ count: 0, names: [] })
  })

  it('pageLoad() -- the editor entry point load, when there are no pending local edits -- reaches the store with what the GET page route answered', async () => {
    const pageStore = usePageStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: '5',
          relations: [],
          tocDepth: {},
          viewer: {
            permissions: ['write:pages'],
            isWatching: false,
            activeEditors: { count: 1, names: ['Ada Lovelace'] }
          }
        })
    })

    await pageStore.pageLoad({ id: '5' })

    expect(pageStore.activeEditors).toEqual({ count: 1, names: ['Ada Lovelace'] })
  })
})

describe('page store: viewer.draft (OpenProject #2455)', () => {
  it('applyViewerState() carries draft onto the store as-is', () => {
    const pageStore = usePageStore()

    pageStore.applyViewerState({
      permissions: [],
      isWatching: false,
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Ada Lovelace' }
    })

    expect(pageStore.draft).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada Lovelace'
    })
  })

  it('applyViewerState() defaults to null when the server omits draft', () => {
    const pageStore = usePageStore()
    // -> Not a real response shape (the route always sends it), but the same defensive fallback
    //    every other viewer field gets here
    pageStore.applyViewerState({ permissions: [] })

    expect(pageStore.draft).toBe(null)
  })

  it('pageNotFound() clears any draft the previously open page carried', () => {
    const pageStore = usePageStore()
    pageStore.draft = { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Ada Lovelace' }

    pageStore.pageNotFound({ path: 'gone' })

    expect(pageStore.draft).toBe(null)
  })

  it('pageLoad() reaches the store with what the GET page route answered', async () => {
    const pageStore = usePageStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: '5',
          relations: [],
          tocDepth: {},
          viewer: {
            permissions: ['write:pages'],
            isWatching: false,
            draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Ada Lovelace' }
          }
        })
    })

    await pageStore.pageLoad({ id: '5' })

    expect(pageStore.draft).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada Lovelace'
    })
  })
})

describe('page store: pageLoad()', () => {
  it('sends no locale search param when none is given', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/some/page' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: false })
  })

  it('passes the resolved locale as the locale search param', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/some/page', locale: 'fr' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: false, locale: 'fr' })
  })

  it('normalizes an embedded space the same way the backend does before hashing (OpenProject #1933)', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/my page' })

    const [url] = API_CLIENT.get.mock.calls[0]
    // -> `normalizePagePath('/my page')` -> `'my-page'`, matching `backend/api/pages/read.ts`'s
    //    by-path lookup for the same input. A drifted local copy that skipped the whitespace-to-hyphen step
    //    would hash `'my page'` instead, resolving to a hash the server never assigns.
    expect(url).toBe(`sites/site-1/pages/${pagePathHash('my-page')}`)
  })

  /*
   * OpenProject #1785: `isStale` is the hook `Index.vue`'s route-path watcher passes so a slower,
   * now-superseded call's response cannot stomp whatever a faster, later navigation already wrote.
   * Driven directly here (rather than through a full `Index.vue` mount) to pin the store's own half
   * of the guard in isolation -- the watcher-level wiring gets its own coverage in `Index.test.js`.
   */
  describe('isStale guard (OpenProject #1785)', () => {
    it('performs no store write when isStale() is true once the response resolves', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      // -> A page already on screen, standing in for whatever a faster, later navigation already
      //    landed on -- asserted unchanged below.
      pageStore.$patch({ id: 'page-b', path: 'page-b', title: 'Page B' })

      await pageStore.pageLoad({ path: '/page-a', isStale: () => true })

      expect(pageStore.id).toBe('page-b')
      expect(pageStore.title).toBe('Page B')
    })

    it('does not throw ERR_PAGE_NOT_FOUND for a stale response, even when the page truly is missing', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      // -> The default stub shape: no `id` on the payload is what a 404 lookup resolves to
      //    (`pageLoad`'s own `!pageData?.id` check), which would normally throw.
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(undefined) })

      const pageStore = usePageStore()
      await expect(
        pageStore.pageLoad({ path: '/gone', isStale: () => true })
      ).resolves.toBeUndefined()
    })

    it('writes the store as usual when isStale() is false', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      await pageStore.pageLoad({ path: '/page-a', isStale: () => false })

      expect(pageStore.id).toBe('page-a')
      expect(pageStore.title).toBe('Page A')
    })

    it('writes the store as usual when isStale is omitted, unchanged for every other caller', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      await pageStore.pageLoad({ path: '/page-a' })

      expect(pageStore.id).toBe('page-a')
      expect(pageStore.title).toBe('Page A')
    })
  })
})
