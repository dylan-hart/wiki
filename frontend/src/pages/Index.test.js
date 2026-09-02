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

describe('Index.vue: page-view comments gating', () => {
  it('does not render page-comments when the site feature is off, even if the page allows it', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    siteStore.features.comments = false
    pageStore.allowComments = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)
  })

  it('does not render page-comments when the page disallows it, even if the site feature is on', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    siteStore.features.comments = true
    pageStore.allowComments = false
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)
  })

  it('renders page-comments once both the site feature and the page allow it, reactively', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)

    siteStore.features.comments = true
    pageStore.allowComments = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(true)
  })
})

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
 * OpenProject #813: the breadcrumb bar (trail + "Last modified") used to unmount the moment
 * `editorStore.isActive` flipped true. It now stays up through editing, gated only on there being a
 * page at all (`pageStore.notFound`) -- with "Last modified" itself further hidden for a page that
 * has never been saved, where there is no true last-saved moment to report.
 */
describe('Index.vue: breadcrumb bar during editing (OpenProject #813)', () => {
  it('stays mounted once the editor is active, unlike before', async () => {
    const { wrapper, editorStore } = await mountIndex()
    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(true)

    editorStore.isActive = true
    editorStore.mode = 'edit'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(true)
  })

  it('stays hidden for a path with no page at all, editor or not', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.notFound = true
    editorStore.isActive = true
    editorStore.mode = 'create'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(false)
  })

  it('keeps "Last modified" visible while editing an already-saved page', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.updatedAt = '2026-01-01T00:00:00.000Z'
    editorStore.isActive = true
    editorStore.mode = 'edit'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Last modified on')
  })

  it('hides "Last modified" but keeps the trail for a page that has never been saved', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.$patch({ path: 'new-page', updatedAt: '' })
    editorStore.isActive = true
    editorStore.mode = 'create'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('Last modified on')
    expect(wrapper.findComponent({ name: 'WBreadcrumbs' }).exists()).toBe(true)
  })
})

/**
 * OpenProject #817: the "Unpublished" chip rendering was guarded by a broken condition
 * `!pageStore.publishState === 'draft'`, which due to operator precedence parsed as
 * `(!pageStore.publishState) === 'draft'` — always false since a negated value is a boolean,
 * never the string 'draft'. Fixed to `pageStore.publishState === 'draft'`.
 */
describe('Index.vue: unpublished chip (OpenProject #817)', () => {
  it('renders the "Unpublished" chip when publishState is "draft"', async () => {
    const { wrapper, pageStore } = await mountIndex()
    pageStore.publishState = 'draft'
    await wrapper.vm.$nextTick()

    const chip = wrapper.find('.text-accent')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Unpublished')
  })

  it('does not render the chip when publishState is not "draft"', async () => {
    const { wrapper, pageStore } = await mountIndex()
    pageStore.publishState = 'published'
    await wrapper.vm.$nextTick()

    const chip = wrapper.find('div:has-text("Unpublished")')
    expect(chip.exists()).toBe(false)
  })

  it('renders the separator only when the chip renders', async () => {
    const { wrapper, pageStore } = await mountIndex()
    const separator = () => wrapper.findComponent({ name: 'WSeparator' })

    expect(separator().exists()).toBe(false)

    pageStore.publishState = 'draft'
    await wrapper.vm.$nextTick()

    expect(separator().exists()).toBe(true)
  })
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
describe('Index.vue: read-path block loading for a directly-loaded/reloaded page (OpenProject #829 item 1)', () => {
  it('loads a block found only in the stored page render, never having gone through the live editor preview', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    // -> The block-loading scan resolves `block-diagram` off `siteStore.blocksIndex` (a public
    //    field on the site-info response every reader's browser already has -- see
    //    `siteBlocksInfoFor` in `backend/api/sites.ts`, OpenProject #954) rather than a network
    //    call. Set directly here rather than via `applySiteInfo`, since nothing else this test
    //    checks needs a full site-info payload. A tag absent from this index is skipped entirely
    //    since OpenProject #1729, so it has to be present for this test's block to load at all.
    const siteStore = useSiteStore()
    siteStore.blocksIndex = { diagram: { id: null, isCustom: false } }

    // -> The shape `rendering.postProcess` actually stores: the block element plus its fenced
    //    mermaid source, exactly as a reload's GET would hand it back -- see
    //    `rendering.test.ts`'s "render, save, reload" describe block for where this shape comes from.
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'diagram-page',
          editor: 'markdown',
          render:
            '<p>Some text.</p>' +
            '<block-diagram theme="auto"><pre class="codeblock-mermaid"><code>A --&gt; B</code></pre></block-diagram>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    const loadedTags = loadBlocksSpy.mock.calls.flatMap((call) =>
      call[0].map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    )
    expect(loadedTags).toContain('block-diagram')

    wrapper.unmount()
  })
})

/**
 * OpenProject #1734: the block scan below used to call `commonStore.loadBlocks()` once PER
 * undefined element, rather than once for the whole page. `loadBlocks()`'s own `!blocksLoaded
 * .includes(...)` filter only screens out a tag that has ALREADY finished loading, so N concurrent
 * calls for the same not-yet-loaded tag all pass it -- a page with several elements of the same tag
 * (a `block-tabs` used three times, say) fired three identical `loadBlocks()` calls instead of one,
 * making `blocksLoaded` misleading to anyone debugging block loading. Collapsed into a single call
 * with one Map entry per tag, mirroring `EditorMarkdown.vue`'s own `pendingBlocks` Map.
 */
describe('Index.vue: collapses the block scan into one loadBlocks() call (OpenProject #1734)', () => {
  it('produces exactly one loadBlocks() call carrying one entry per tag, for a page with several elements sharing a tag', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    const siteStore = useSiteStore()
    siteStore.blocksIndex = {
      tabs: { id: null, isCustom: false },
      alert: { id: null, isCustom: false }
    }

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'tabbed-page',
          editor: 'markdown',
          render:
            '<block-tabs>One</block-tabs>' +
            '<block-tabs>Two</block-tabs>' +
            '<block-tabs>Three</block-tabs>' +
            '<block-alert>Note</block-alert>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    expect(loadBlocksSpy).toHaveBeenCalledTimes(1)
    const [entries] = loadBlocksSpy.mock.calls[0]
    const tags = entries.map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    expect(tags).toEqual(['block-tabs', 'block-alert'])

    wrapper.unmount()
  })
})

/**
 * OpenProject #1729: a `block-*` tag absent from `siteStore.blocksIndex` used to fall back to the
 * bare tag, which `loadBlocks()` resolves to the flat, unauthenticated `/_blocks/<tag>.js` URL --
 * so a block a site administrator had switched off still loaded for a reader whose stored page HTML
 * still embedded it. `blockAllowances()`/`siteBlocksInfoFor` document that a disabled block must
 * never reach a reader's browser, neither its config nor a URL to fetch its code from.
 *
 * `block-tab` is the one legitimate absent-from-`blocksIndex` case: a child block gets no row of
 * its own (`models/blocks.ts#syncSite`), so it never appears there even when its parent `block-tabs`
 * is enabled -- told apart from a disabled block by ancestry, the same way the server's own
 * `unwrapOrphanedChildBlocks` (`backend/models/rendering.ts`) does.
 */
describe('Index.vue: reader-view block scan skips a block absent from blocksIndex (OpenProject #1729)', () => {
  it('does not load a block-* tag absent from blocksIndex, but still loads a child block whose parent is present', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    const siteStore = useSiteStore()
    // -> `tabs` (the parent) is enabled; `tab` (the child) never gets a row of its own, so it is
    //    never a key here even when its parent is. `widget` stands in for a block the site has
    //    switched off -- absent from the index the same way, but with no enabled ancestor to save it.
    siteStore.blocksIndex = { tabs: { id: null, isCustom: false } }

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'tabs-page',
          editor: 'markdown',
          render:
            '<block-tabs><block-tab name="One">Content</block-tab></block-tabs>' +
            '<block-widget>disabled block markup left over in stored HTML</block-widget>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    const loadedTags = loadBlocksSpy.mock.calls.flatMap((call) =>
      call[0].map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    )
    expect(loadedTags).toContain('block-tabs')
    expect(loadedTags).toContain('block-tab')
    expect(loadedTags).not.toContain('block-widget')

    wrapper.unmount()
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
