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
 * The `/_create` and `/_edit` route-watcher branches raise the full-screen loading overlay before
 * awaiting `pageCreate`/`pageEdit`, either of which can reject -- `ERR_PAGE_NOT_FOUND` for a bad
 * path, or `fetchConfigs()`'s own network call. Without a catch, the overlay never comes down and
 * the error reaches nothing but the console.
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
      The handler's `router.replace('/')` lands on the plain page-load branch, which 404s against
      this stub too. Authenticated with `manage:system` so that ends on the quiet
      `siteStore.overlay = 'Welcome'` outcome rather than a `router.push('/login')` the minimal route
      table below does not register.
    */
    const router = buildTestRouter([
      '/',
      { path: '/_create/:editor?', component: Index },
      { path: '/_edit/:pagePath(.*)?', component: Index }
    ])
    // -> Straight to the target route as the FIRST navigation: `/` then a second `push()` would run
    //    the immediate route watcher against `/`, whose 404 pushes to an unregistered `/login`.
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
        PageComments: true,
        PageCommentsEmbed: true
      }
    })
    activeWrapper = wrapper

    // -> `loading.show()` waits 500ms before `isActive` flips `true` at all, so without advancing
    //    past it an overlay stuck up forever would read exactly like one that never appeared.
    await vi.advanceTimersByTimeAsync(600)

    return { wrapper, router }
  }

  it('/_edit/<bad-path>: hides the overlay, notifies, and returns to "/" instead of stranding the app', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    // -> No mock needed: the default `API_CLIENT.get` stub resolves `undefined`, which `pageLoad`
    //    already treats as `ERR_PAGE_NOT_FOUND`.
    const { wrapper, router } = await mountAtRoute('/_edit/this-page-does-not-exist')

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
    expect(router.currentRoute.value.path).toBe('/')

    wrapper.unmount()
  })

  it('/_create: hides the overlay and notifies instead of stranding the app when pageCreate rejects', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    // -> Simplest real rejection: `pageCreate` awaits `editorStore.fetchConfigs()`, which throws
    //    outright with no site id to fetch against, so no network mocking is needed.
    const { wrapper } = await mountAtRoute('/_create/markdown', { siteId: '' })

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })

    wrapper.unmount()
  })
})

/**
 * The route watcher's plain page-load branch needs a generation guard: without one, an earlier
 * navigation's slower response landing AFTER a later one has resolved stomps the store with stale
 * data -- title, body, tags and, through `applyViewerState`, the reader's `pagePermissions` for the
 * page actually on screen. Driven here as "A -> B, A resolves last".
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

    // -> Consumed in call order -- page-a's load at mount, then page-b's -- but resolved out of it.
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
          PageComments: true,
          PageCommentsEmbed: true
        }
      }
    })
    activeWrapper = wrapper
    await flushPromises()

    router.push('/page-b')
    await router.isReady()
    await flushPromises()

    resolvePageB({
      id: 'page-b',
      path: 'page-b',
      title: 'Page B',
      relations: [],
      tocDepth: {},
      viewer: { permissions: ['read:pages'] }
    })
    await flushPromises()

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
