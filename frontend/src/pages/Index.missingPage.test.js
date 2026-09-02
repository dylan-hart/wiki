import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { isActive as loadingIsActive } from '@/composables/loading'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter, createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for task 633's wiring: `PageComments.vue` is mounted inside the article
 * column, gated on `siteStore.features.comments && pageStore.allowComments` -- the same
 * boolean-AND pattern the adjacent ratings block already uses. Everything else `Index.vue` renders
 * is stubbed out: this view pulls in the editor, header, TOC and actions column, none of which this
 * task touches, and giving each its own store/route/permission setup here would test THEIR
 * behaviour, not the gate this task added.
 */

/*
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and the common store's `state()`
 * reads `localStorage.getItem('locale')` the moment it's instantiated. Neither has been needed by
 * any existing test -- mounting a full page view, which pulls in `useCommonStore`, is new here --
 * so both are stubbed locally rather than added to the shared `test/setup.js`, which would be a
 * bigger claim about every future test's needs than this one warrants. `localStorage` in particular
 * is a real (but non-functional, `--localstorage-file`-less) Node global in this runtime rather than
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
 * Torn down after every test, not left for the next mount to overwrite: `setActivePinia` in the
 * next test replaces the active pinia instance while this one's stores are still live, and an
 * un-unmounted component keeps its watchers/computeds running against them -- which then observe a
 * disposed reactive scope (`pagePermissions.includes` on a revoked proxy) as an unhandled rejection
 * on the next microtask, unrelated to whatever that next test is actually asserting.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountIndex() {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])

  // -> Real English messages for the couple of keys these tests assert the rendered text of
  //    (`common.page.unpublished`, `common.page.lastModifiedOn`); every other `t()` call in the
  //    component renders as its bare key, same as before this list existed, which none of these
  //    tests reads.
  const i18n = createTestI18n({
    common: {
      page: { unpublished: 'Unpublished', lastModifiedOn: 'Last modified on' }
    }
  })

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true
      }
    }
  })
  activeWrapper = wrapper

  return {
    wrapper,
    pageStore: usePageStore(),
    siteStore: useSiteStore(),
    editorStore: useEditorStore()
  }
}
/**
 * Regression test for task 515's entry point out of the missing-page screen.
 *
 * A path that 404s is also what a deleted page's own address does once nothing is left to answer for
 * it, so this is "wherever a reader currently lands when a page's path no longer resolves" — the
 * landing spot task 515 names as one acceptable place for a lightweight link into the new Recently
 * Deleted admin view. It is gated on TWO permissions rather than shown unconditionally: `read:history`
 * at this exact path is what a row for this path would need to appear on that list at all (see
 * `GET sites/:siteId/pages/deleted`'s per-row `mayOnPage` filter), and the global `access:admin` is
 * what `AdminLayout` itself checks on arrival -- without it the link would only bounce the reader to
 * the unauthorized screen. A group can grant either without the other, so both are asserted here.
 */
async function mountAtMissingPath({ pagePermissions, permissions = [] }) {
  // -> `stores/common.js` reads `localStorage` at store setup. Node's own experimental global
  //    shadows happy-dom's in this sandbox and throws on `.getItem` with no backing file
  //    configured; stubbed locally so this test does not depend on either implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.editors.markdown = false // -> Keeps the screen on the simpler "go back" branch

  const userStore = useUserStore()
  userStore.permissions = permissions

  // -> `pageLoad`'s GET resolves to `undefined` by default (the stub's plain response), which is
  //    exactly what makes it throw ERR_PAGE_NOT_FOUND and take the missing-page path below
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
/*
 * OpenProject #829, item 1: upstream issue #1839 ("Mermaid renders in the live edit preview but not
 * on the saved/reloaded page") and discussion #6446 (the identical pattern for KaTeX). This is the
 * frontend half of the render-then-reload regression test the item asks for -- `rendering.test.ts`
 * covers the save-time half (a diagram block and a resolved formula both survive `postProcess`
 * byte-for-byte); this covers what actually draws a diagram once that stored HTML comes back down.
 *
 * A diagram block is a Lit custom element that draws itself in its own `firstUpdated()` once its
 * component script has been imported and the tag upgrades -- it does not matter whether that
 * happened because the live editor preview loaded it moments ago or because this is a page loaded
 * fresh (a direct URL, a browser reload) that has never seen the editor at all. What matters is that
 * SOMETHING scans the page for an undefined block tag and imports it either way. This mounts
 * `Index.vue` exactly as a reader loading a saved page directly would -- `pageStore.pageLoad`
 * resolving real page data whose `render` is what `rendering.test.ts` proved a save writes to
 * storage -- and asserts the block-loading scan this view's route watcher runs (`{ immediate: true }`,
 * so it also covers the very first load of a page, not only navigating between two already-open
 * ones) picks the diagram up, with no live editor ever having been open in this test at all.
 */

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
 * OpenProject #2063: the `/` branch of the `ERR_PAGE_NOT_FOUND` handler used to decide between the
 * Welcome overlay and `/_error/unauthorized` off `userStore.can('write:pages')` alone -- `write:pages`
 * is a page-rule permission, never present in the global `permissions` list, so on a cold load (where
 * `pagePermissions` is still empty) that check could only ever pass for `manage:system`. Every
 * delegated editor holding `write:pages` through a page rule saw a factually-wrong 403 instead of the
 * page they were entitled to create. The fix fetches page permissions at `'home'` first, same as the
 * non-root branch already does for its own missing-page screen, and answers a "may not write" reader
 * with that same placeholder rather than an error route.
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

    // -> `pageLoad`'s GET resolves to `undefined` by default (the stub's plain response), which is
    //    exactly what makes it throw ERR_PAGE_NOT_FOUND and take the missing-home-page path below
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

    // -> The overlay must not have been set yet -- proof the decision waited on the fetch
    expect(siteStore.overlay).not.toBe('Welcome')
    expect(userStore.fetchPagePermissions).toHaveBeenCalledWith('home', 'en')

    resolveFetch()
    order.push('decided')
    await flushPromises()

    expect(siteStore.overlay).toBe('Welcome')
    expect(order).toEqual(['fetch:home', 'decided'])
  })
})
