import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/*
 * `useScreen` calls `window.matchMedia`, and the common store reads `localStorage` the moment it is
 * instantiated. `localStorage` is a real but non-functional Node global in this runtime rather than
 * simply absent, so it has to be overwritten, not merely filled in when missing.
 */
beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
})

/*
 * Torn down after every test: the next test's `setActivePinia` replaces the active instance while a
 * still-mounted component's watchers run against the old one, which surfaces as an unhandled
 * rejection over a disposed reactive scope inside whatever test comes next.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

/**
 * The Recently Deleted link is gated on two permissions a group can grant independently:
 * `read:history` at this exact path is what a row for it needs to appear on that list at all (`GET
 * sites/:siteId/pages/deleted` filters per row), and the global `access:admin` is what `AdminLayout`
 * checks on arrival -- without it the link would only bounce the reader to the unauthorized screen.
 */
async function mountAtMissingPath({ pagePermissions, permissions = [] }) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.editors.markdown = false // -> Keeps the screen on the simpler "go back" branch

  const userStore = useUserStore()
  userStore.permissions = permissions

  // -> The GET stub is left at its default `undefined`, which is what makes `pageLoad` throw
  //    ERR_PAGE_NOT_FOUND and land on the missing-page screen.
  globalThis.API_CLIENT.post.mockReturnValue({
    json: vi.fn().mockResolvedValue(pagePermissions)
  })

  const router = buildTestRouter([{ path: '/:pathMatch(.*)*', component: Index }])

  const i18n = createTestI18n()

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageRedirect: true,
        PageTags: true,
        PageToc: true,
        FooterNav: true,
        SideDialog: true
      }
    }
  })

  router.push('/deleted/page')
  await router.isReady()
  await flushPromises()

  return { wrapper, userStore }
}

describe('Index missing-page screen: Recently Deleted entry link', () => {
  it('shows the link when both access:admin and read:history at this path are granted', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: ['read:history'],
      permissions: ['access:admin']
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(true)
  })

  it('hides the link when this path grants no read:history, even with access:admin', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: [],
      permissions: ['access:admin']
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(false)
  })

  it('hides the link when there is no access:admin, even with read:history here', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: ['read:history'],
      permissions: []
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(false)
  })
})

/**
 * `write:pages` is a page-rule permission, never present in the global `permissions` list, so the
 * site-root branch of the `ERR_PAGE_NOT_FOUND` handler has to fetch page permissions at `'home'`
 * before choosing between the Welcome overlay and the placeholder: deciding off
 * `userStore.can('write:pages')` on a cold load could only ever pass for `manage:system`, 403-ing
 * every delegated editor entitled to create the page.
 */
describe('Index.vue: site-root missing-home-page screen (OpenProject #2063)', () => {
  async function mountAtRoot({ authenticated, pagePermissions = [] }) {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    siteStore.editors.markdown = false // -> Keeps the placeholder on the simpler "go back" branch

    const userStore = useUserStore()
    userStore.authenticated = authenticated

    // -> The GET stub is left at its default `undefined`, which is what makes `pageLoad` throw
    //    ERR_PAGE_NOT_FOUND and take the missing-home-page path.
    globalThis.API_CLIENT.post.mockReturnValue({
      json: vi.fn().mockResolvedValue(pagePermissions)
    })

    const router = buildTestRouter([{ path: '/', component: Index }, '/login'])

    const i18n = createTestI18n()

    const wrapper = mount(Index, {
      global: {
        plugins: [router, i18n],
        stubs: {
          PageHeader: true,
          PageActionsCol: true,
          PageRedirect: true,
          PageTags: true,
          PageToc: true,
          FooterNav: true,
          SideDialog: true
        }
      }
    })
    activeWrapper = wrapper

    router.push('/')
    await router.isReady()
    await flushPromises()

    return { wrapper, userStore, siteStore, router }
  }

  it('shows the Welcome overlay when the fetched page permissions grant write:pages', async () => {
    const { siteStore, router } = await mountAtRoot({
      authenticated: true,
      pagePermissions: ['write:pages']
    })

    expect(siteStore.overlay).toBe('Welcome')
    expect(router.currentRoute.value.path).not.toBe('/_error/unauthorized')
  })

  it('shows the missing-page placeholder, never /_error/unauthorized, when the fetched permissions lack write:pages', async () => {
    const { wrapper, siteStore, router } = await mountAtRoot({
      authenticated: true,
      pagePermissions: []
    })

    expect(siteStore.overlay).not.toBe('Welcome')
    expect(router.currentRoute.value.path).not.toBe('/_error/unauthorized')
    expect(wrapper.find('.page-placeholder').exists()).toBe(true)
  })

  it('sends an unauthenticated visitor to /login without fetching page permissions', async () => {
    const { userStore, router } = await mountAtRoot({ authenticated: false })

    expect(router.currentRoute.value.path).toBe('/login')
    expect(userStore.pagePermissions).toEqual([])
  })

  it('awaits fetchPagePermissions("home", …) before deciding, so the ordering does not regress', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    siteStore.editors.markdown = false

    const userStore = useUserStore()
    userStore.authenticated = true

    let resolveFetch
    const order = []
    vi.spyOn(userStore, 'fetchPagePermissions').mockImplementation(
      (path, locale) =>
        new Promise((resolve) => {
          order.push(`fetch:${path}`)
          resolveFetch = () => {
            userStore.pagePermissions = ['write:pages']
            resolve()
          }
        })
    )

    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue(undefined)
    })

    const router = buildTestRouter([{ path: '/', component: Index }, '/login'])
    const i18n = createTestI18n()

    const wrapper = mount(Index, {
      global: {
        plugins: [router, i18n],
        stubs: {
          PageHeader: true,
          PageActionsCol: true,
          PageRedirect: true,
          PageTags: true,
          PageToc: true,
          FooterNav: true,
          SideDialog: true
        }
      }
    })
    activeWrapper = wrapper

    router.push('/')
    await router.isReady()
    await flushPromises()

    expect(siteStore.overlay).not.toBe('Welcome')
    expect(userStore.fetchPagePermissions).toHaveBeenCalledWith('home', 'en')

    resolveFetch()
    order.push('decided')
    await flushPromises()

    expect(siteStore.overlay).toBe('Welcome')
    expect(order).toEqual(['fetch:home', 'decided'])
  })
})
