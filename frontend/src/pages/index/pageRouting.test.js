import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { enterCreateMode, enterEditMode, loadPageForRoute } from './pageRouting'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { stubPageResponse } from '@/stores/pageStoreFixtures'
import { stubRouter } from '../../../test/fixtures.js'

function fakeRouter() {
  return { push: vi.fn(), replace: vi.fn() }
}

function stubPermissionFetch(userStore, { authenticated = true, grants = ['write:pages'] } = {}) {
  userStore.authenticated = authenticated
  return vi.spyOn(userStore, 'fetchPagePermissions').mockImplementation(async () => {
    userStore.pagePermissions = grants
  })
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
    const fetchSpy = stubPermissionFetch(userStore)

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
    const fetchSpy = stubPermissionFetch(userStore)

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

  it('returns to / without opening the editor when pageCreate itself rejects', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    stubPermissionFetch(userStore)
    // -> `pageCreate` awaits `editorStore.ensureConfigs()` first, which rejects with no site id
    const siteStore = useSiteStore()
    siteStore.id = ''

    const route = { params: { editor: 'markdown' }, query: {} }
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(useEditorStore().isActive).toBe(false)
    expect(router.replace).toHaveBeenCalledWith('/')
  })
})

describe('enterCreateMode() refuses a session without write:pages before opening the editor (OpenProject #3757)', () => {
  const route = { params: { editor: 'markdown' }, query: { path: 'guides/new-guide' } }

  it('sends an anonymous visitor to the unauthorized screen without asking the server', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    const fetchSpy = stubPermissionFetch(userStore, { authenticated: false })
    const pageCreateSpy = vi.spyOn(pageStore, 'pageCreate')
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(pageCreateSpy).not.toHaveBeenCalled()
    expect(useEditorStore().isActive).toBe(false)
    expect(router.replace).toHaveBeenCalledWith('/_error/unauthorized')
  })

  it('refuses a logged-in user who lacks write:pages at the target path', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    const fetchSpy = stubPermissionFetch(userStore, { grants: ['read:pages'] })
    const pageCreateSpy = vi.spyOn(pageStore, 'pageCreate')
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(fetchSpy).toHaveBeenCalledWith('guides/new-guide', pageStore.locale)
    expect(pageCreateSpy).not.toHaveBeenCalled()
    expect(useEditorStore().isActive).toBe(false)
    expect(router.replace).toHaveBeenCalledWith('/_error/unauthorized')
  })

  it('refuses when the permission lookup itself fails', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    userStore.authenticated = true
    globalThis.API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network')
    })
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(useEditorStore().isActive).toBe(false)
    expect(router.replace).toHaveBeenCalledWith('/_error/unauthorized')
  })

  it('opens the editor in create mode for a user holding write:pages there', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    stubPermissionFetch(userStore)
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    const editorStore = useEditorStore()
    expect(editorStore.isActive).toBe(true)
    expect(editorStore.mode).toBe('create')
    expect(pageStore.path).toBe('guides/new-guide')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('lets manage:system through whatever the page rules say', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    const userStore = useUserStore()
    userStore.permissions = ['manage:system']
    stubPermissionFetch(userStore, { grants: [] })
    const router = fakeRouter()

    await enterCreateMode(route, { router, t: (key) => key })

    expect(useEditorStore().isActive).toBe(true)
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('asks about the same default path pageCreate lands on when the route carries none', async () => {
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.path = 'guides/intro'
    const userStore = useUserStore()
    const fetchSpy = stubPermissionFetch(userStore)
    const router = fakeRouter()

    await enterCreateMode(
      { params: { editor: 'markdown' }, query: {} },
      { router, t: (key) => key }
    )

    expect(fetchSpy).toHaveBeenCalledWith('guides/new-page', pageStore.locale)
    expect(pageStore.path).toBe('guides/new-page')
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

describe('loadPageForRoute() resolves a locale URL alias to the canonical locale', () => {
  async function load(path) {
    const siteStore = useSiteStore()
    siteStore.locales = {
      primary: 'en',
      forcePrefix: false,
      aliases: { 'zh-CN': 'zh' },
      active: [
        { code: 'en', name: 'English', nativeName: 'English' },
        { code: 'zh-CN', name: 'Chinese', nativeName: '中文' }
      ]
    }
    const pageLoad = vi.spyOn(usePageStore(), 'pageLoad').mockResolvedValue()
    await loadPageForRoute({ path, hash: '' }, 1, {
      router: fakeRouter(),
      state: { tocPanelOpen: false },
      pageContents: { value: null },
      scrollPageToTop: vi.fn(),
      currentGeneration: () => 1
    })
    return pageLoad
  }

  it('loads locale zh-CN at the page `page` for /zh/page', async () => {
    const pageLoad = await load('/zh/page')

    expect(pageLoad).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/page', locale: 'zh-CN' })
    )
  })

  it('still loads locale zh-CN at the page `page` for the canonical /zh-CN/page', async () => {
    const pageLoad = await load('/zh-CN/page')

    expect(pageLoad).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/page', locale: 'zh-CN' })
    )
  })
})
