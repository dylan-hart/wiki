import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'
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

/**
 * OpenProject #947, item 1: the `/_create` and `/_edit` route-watcher branches called
 * `loading.show()` then `await pageStore.pageCreate(...)`/`pageEdit(...)` with no try/catch, unlike
 * the plain page-load branch (whose own catch handles every error `pageLoad` can throw). A rejection
 * -- `pageEdit` throws `ERR_PAGE_NOT_FOUND` for a bad path, `pageCreate` can reject from its own
 * `fetchConfigs()` network call -- left the full-screen loading overlay stuck up forever with the
 * error only in the console.
 */
describe('Index.vue: /_create and /_edit route-watcher error handling (OpenProject #947)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountAtRoute(path, { siteId = 'site-1' } = {}) {
    /*
      This fix's own `router.replace('/')` lands on the plain page-load branch for `/`, which --
      since the API stub 404s everything -- runs its own, unrelated `ERR_PAGE_NOT_FOUND` handling
      too. Authenticated with `manage:system` here specifically to land that on the quiet
      `siteStore.overlay = 'Welcome'` outcome rather than a further `router.push('/login')` this
      test's minimal route table does not register -- keeping the assertions below about what THIS
      fix did, not about that unrelated cascade.
    */
    const router = buildTestRouter([
      '/',
      { path: '/_create/:editor?', component: Index },
      { path: '/_edit/:pagePath(.*)?', component: Index }
    ])
    // -> Navigates straight to the target route as the FIRST navigation, matching
    //    `mountAtMissingPath`'s own pattern above -- not `/` then a second `push()`, which would run
    //    the immediate route watcher against `/` first (a 404 there, with this suite's guest/no-page
    //    stub setup, itself pushes to `/login`, a route this router does not register) before ever
    //    reaching the path this test actually cares about.
    router.push(path)
    await router.isReady()

    const { wrapper } = mountWithApp(Index, {
      router,
      stores: {
        site: { id: siteId },
        user: { authenticated: true, permissions: ['manage:system'] }
      },
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
    })
    activeWrapper = wrapper

    // -> `loading.show()`'s own 500ms delay (`composables/loading.js`) has to actually elapse for
    //    `isActive` to ever flip `true` at all; advancing past it is what would have caught the
    //    overlay stuck on `true` forever pre-fix, since the bare, unguarded `await` never reached the
    //    matching `loading.hide()` below it.
    await vi.advanceTimersByTimeAsync(600)

    return { wrapper, router }
  }

  it('/_edit/<bad-path>: hides the overlay, notifies, and returns to "/" instead of stranding the app', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    // -> No mock needed: the default `API_CLIENT.get` stub resolves `{ json: () =>
    //    Promise.resolve(undefined) }`, which `pageStore.pageLoad` (called by `pageEdit`) already
    //    treats as `ERR_PAGE_NOT_FOUND` (`!pageData?.id`).
    const { wrapper, router } = await mountAtRoute('/_edit/this-page-does-not-exist')

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
    expect(router.currentRoute.value.path).toBe('/')

    wrapper.unmount()
  })

  it('/_create: hides the overlay and notifies instead of stranding the app when pageCreate rejects', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    // -> Simplest real rejection: `pageCreate` awaits `editorStore.fetchConfigs()`, which throws
    //    outright when there is no site id to fetch against -- no network mocking required.
    const { wrapper } = await mountAtRoute('/_create/markdown', { siteId: '' })

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })

    wrapper.unmount()
  })
})

/**
 * OpenProject #1785: the plain page-load branch of the route watcher awaited `pageStore.pageLoad`
 * with no generation guard, so a slower, earlier navigation's response landing AFTER a faster, later
 * one already resolved would stomp the store with stale data -- title, body, tags and, through
 * `applyViewerState`, the reader's `pagePermissions` for the page actually on screen. This drives
 * that exact "A -> B, A resolves last" ordering with two manually-controlled responses and asserts
 * the superseded load (A) performs no store write at all.
 */
describe('Index.vue: generation guard on the route-path watcher (OpenProject #1785)', () => {
  it('discards a stale pageLoad response that resolves after a newer navigation already landed', async () => {
    setActivePinia(createPinia())

    const router = await createTestRouter(
      [{ path: '/:pathMatch(.*)*', component: Index }],
      '/page-a'
    )

    const i18n = createTestI18n()

    let resolvePageA
    const pageAResponse = new Promise((resolve) => {
      resolvePageA = resolve
    })
    let resolvePageB
    const pageBResponse = new Promise((resolve) => {
      resolvePageB = resolve
    })

    // -> Consumed in call order (page-a's own load, started at mount, then page-b's, started by the
    //    `router.push` below) -- resolved out of that order further down, which is the whole point.
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => pageAResponse })
      .mockReturnValueOnce({ json: () => pageBResponse })

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
    await flushPromises()

    router.push('/page-b')
    await router.isReady()
    await flushPromises()

    // -> The faster, later navigation (B) resolves first, same as it would racing a slow network for A.
    resolvePageB({
      id: 'page-b',
      path: 'page-b',
      title: 'Page B',
      relations: [],
      tocDepth: {},
      viewer: { permissions: ['read:pages'] }
    })
    await flushPromises()

    // -> Then the slower, now-superseded earlier navigation (A) resolves after it.
    resolvePageA({
      id: 'page-a',
      path: 'page-a',
      title: 'Page A',
      relations: [],
      tocDepth: {},
      viewer: { permissions: ['write:pages'] }
    })
    await flushPromises()

    const pageStore = usePageStore()
    const userStore = useUserStore()
    expect(pageStore.id).toBe('page-b')
    expect(pageStore.title).toBe('Page B')
    expect(userStore.pagePermissions).toEqual(['read:pages'])
  })
})
