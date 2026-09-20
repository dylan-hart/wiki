import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { enterCreateMode, enterEditMode } from './pageRouting'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { stubPageResponse } from '@/stores/pageStoreFixtures'
import { stubRouter } from '../../../test/fixtures.js'

function fakeRouter() {
  return { push: vi.fn(), replace: vi.fn() }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
})

describe('enterCreateMode() fetches page permissions for the resolved create path (OpenProject #3417)', () => {
  it('fetches permissions for the target path once pageCreate resolves it', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions').mockResolvedValue()

    const route = {
      params: { editor: 'markdown' },
      query: { path: 'some/new-page', locale: 'fr' }
    }
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(pageStore.path).toBe('some/new-page')
    expect(fetchSpy).toHaveBeenCalledWith('some/new-page', 'fr')
  })

  it('fetches permissions for the default new-page slug when the route carries no path', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions').mockResolvedValue()

    const route = { params: { editor: 'markdown' }, query: {} }
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(pageStore.path).toBe('new-page')
    expect(fetchSpy).toHaveBeenCalledWith('new-page', pageStore.locale)
  })

  it('never fetches permissions when the route carries no editor at all', async () => {
    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions')

    const route = { params: {}, query: {} }
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
  })

  it('never fetches permissions when pageCreate itself rejects', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions')
    // -> `pageCreate` awaits `editorStore.ensureConfigs()` first, which rejects with no site id
    const siteStore = useSiteStore()
    siteStore.id = ''

    const route = { params: { editor: 'markdown' }, query: {} }
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
  })
})

describe('enterEditMode() fetches page permissions for the loaded page (OpenProject #3417)', () => {
  it('fetches permissions for the path/locale the server actually loaded', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce(
      stubPageResponse({ path: 'existing/page', locale: 'fr' })
    )

    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions').mockResolvedValue()

    const route = { params: { pagePath: 'existing/page' }, query: { locale: 'fr' } }
    const router = fakeRouter()

    await enterEditMode(route, { router })

    const pageStore = usePageStore()
    expect(pageStore.path).toBe('existing/page')
    expect(fetchSpy).toHaveBeenCalledWith('existing/page', 'fr')
  })

  it('never fetches permissions when the route carries no pagePath', async () => {
    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions')

    const route = { params: {}, query: {} }
    const router = fakeRouter()

    await enterEditMode(route, { router })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
  })

  it('never fetches permissions when the page fails to load (ERR_PAGE_NOT_FOUND)', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(undefined) })

    const userStore = useUserStore()
    const fetchSpy = vi.spyOn(userStore, 'fetchPagePermissions')

    const route = { params: { pagePath: 'missing/page' }, query: {} }
    const router = fakeRouter()

    await enterEditMode(route, { router })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
  })
})
