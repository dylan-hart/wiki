import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import HeaderNav from './HeaderNav.vue'
import WBtn from '@/components/shared/WBtn.vue'
import { useMinWidth } from '@/composables/screen'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia` -- stubbed matching wide, so the
 * uncollapsed button row renders rather than `HeaderActionsMenu`'s overflow menu (see
 * `pages/Index.test.js` for the same pattern).
 */
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

/**
 * `initialPath`/`routes` default to the plain `/` stub every pre-existing test in this file relies
 * on; the OpenProject #3313 describe block below is the only caller that overrides either, since it
 * needs `/_graph` (and a content-page catch-all) actually registered for `router.push()`'s target to
 * resolve against.
 */
async function mountHeaderNav({ initialPath = '/', routes = ['/'] } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const router = await createTestRouter(routes, initialPath)

  const i18n = createTestI18n()

  const wrapper = mount(HeaderNav, {
    global: {
      plugins: [router, i18n],
      stubs: {
        AccountMenu: true,
        NewMenu: true,
        HeaderActionsMenu: true,
        HeaderSearch: true
      }
    }
  })
  activeWrapper = wrapper
  await flushPromises()

  return { wrapper, siteStore, userStore, router }
}

/**
 * OpenProject #2050: below the 600px breakpoint (where `HeaderSearch` is unmounted and so cannot
 * claim the shortcut itself), `onKeydown` only ever tested `ev.ctrlKey`, leaving Cmd+K unbound on
 * macOS. `matchMedia` is stubbed here to `matches: false` -- unlike the wide-viewport default from
 * the top-level `beforeEach` -- so `isSearchCollapsed` is true and this handler is the one in play.
 *
 * `composables/screen.js`'s `useMinWidth` caches one `matchMedia` listener per breakpoint at MODULE
 * scope, shared for the whole file's lifetime once the first caller asks for it (see
 * `composables/screen.test.js`'s own header comment) -- so this describe block must run, and mount
 * its first `HeaderNav`, before any other test in this file touches the 600/900px breakpoints,
 * otherwise it would inherit whatever `matches` value that earlier mount already cached instead of
 * the `false` this block needs. Declared first in the file for exactly that reason.
 */
describe('HeaderNav collapsed-search keyboard shortcut (OpenProject #2050)', () => {
  async function mountCollapsed() {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

    const { wrapper, siteStore } = await mountHeaderNav()
    siteStore.features.search = true
    await flushPromises()

    return wrapper
  }

  it('opens the search row on Ctrl+K', async () => {
    const wrapper = await mountCollapsed()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()

    expect(wrapper.find('.header-search-row').exists()).toBe(true)
  })

  it('also opens the search row on Cmd+K (metaKey) -- previously unbound entirely', async () => {
    const wrapper = await mountCollapsed()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await flushPromises()

    expect(wrapper.find('.header-search-row').exists()).toBe(true)
  })
})

/**
 * OpenProject #1218: the browse-by-tags entry point moved out of this button group entirely, docked
 * to the search field instead (`HeaderSearch.test.js` covers it now) -- so it must NOT be one of the
 * icons `HeaderNav` itself renders any more, with `HeaderSearch` stubbed out of the picture here.
 */
describe('HeaderNav "Browse by tags" entry point (OpenProject #1218)', () => {
  it('no longer renders its own link to /_tags -- that now lives in HeaderSearch', async () => {
    const { wrapper } = await mountHeaderNav()

    const tagsLink = wrapper.findAll('a').find((a) => a.attributes('href') === '/_tags')
    expect(tagsLink).toBeFalsy()
  })
})

/**
 * OpenProject #2024/#2531: the badge counts unread page-watch notifications
 * (`unreadNotifications`, populated from `sites/:siteId/notifications/unread-count`), so the button
 * carrying it has to open onto the section that actually lists them -- the Inbox overlay's Watching
 * tab, not the old `/_inbox/watching` route (deleted along with the rest of `/_inbox/*` when the
 * Inbox became a `MainOverlayDialog` entry).
 */
describe('HeaderNav inbox badge destination (OpenProject #2024)', () => {
  it('opens the Inbox overlay onto the Watching tab from the badged inbox button', async () => {
    const { wrapper, siteStore, userStore } = await mountHeaderNav()
    /*
      `useMinWidth`'s shared `matchMedia` cache (`composables/screen.js`) is seeded by whichever test
      in this file asks for the 600/900px breakpoints FIRST -- the OpenProject #2050 describe block
      above deliberately does that with `matches: false`, so by the time this test runs the cache is
      already pinned there and this file's top-level `beforeEach` (which only affects a NEW
      `matchMedia` call, not the already-cached ref) can't undo it. Setting the shared refs directly
      is what `WDrawer.test.js` does for the same cache; forced back to wide/expanded here since this
      button only renders in that branch of the template, not `HeaderActionsMenu`'s overflow menu.
    */
    useMinWidth(600).value = true
    useMinWidth(900).value = true
    userStore.authenticated = true
    await wrapper.vm.$nextTick()

    const inboxButton = wrapper.find('[aria-label="inbox.title"]')
    expect(inboxButton.exists()).toBe(true)
    await inboxButton.trigger('click')

    expect(siteStore.overlay).toBe('Inbox')
    expect(siteStore.overlayOpts).toEqual({ tab: 'watching' })
  })
})

/**
 * OpenProject #2074: "Create New Page" used to draw a ringed plus while every equivalent
 * create-affordance elsewhere (Index.vue, WelcomeOverlay.vue, AdminSites.vue, ...) drew a bare one.
 * The add action is settled on `tabler:plus`, so this button must not drift back to a ringed
 * variant -- `tabler:circle-plus` is the one sitting closest to it in the set.
 */
describe('HeaderNav "Create New Page" icon (OpenProject #2074)', () => {
  it('uses the settled tabler:plus add glyph, not tabler:circle-plus', async () => {
    const { wrapper, userStore } = await mountHeaderNav()
    userStore.permissions = ['write:pages']
    await wrapper.vm.$nextTick()

    const createButton = wrapper.find('[aria-label="common.header.createNewPage"]')
    expect(createButton.exists()).toBe(true)
    expect(createButton.find('[data-icon="tabler:plus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:circle-plus"]').exists()).toBe(false)
  })
})

/**
 * OpenProject #2851/#2852: the replication warning banner, gated on `siteStore.isReplicationEnabled`
 * (the new field off the site payload) and, independently, on a `md` (1024px) width breakpoint --
 * a third row-width question from `isSearchCollapsed`/`isActionsCollapsed` above, since the banner
 * competes for the same row as both but is neither of them.
 */
describe('HeaderNav replication warning banner (OpenProject #2851/#2852)', () => {
  it('is absent when the site is not replicated', async () => {
    const { wrapper, siteStore } = await mountHeaderNav()
    siteStore.isReplicationEnabled = false
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.replication-banner').exists()).toBe(false)
  })

  it('renders the generic warning text when the site is replicated and the viewport is wide', async () => {
    useMinWidth(1024).value = true
    const { wrapper, siteStore } = await mountHeaderNav()
    siteStore.isReplicationEnabled = true
    await wrapper.vm.$nextTick()

    const banner = wrapper.find('.replication-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toBe('common.header.replicationWarning')
  })

  it('drops the banner below the md breakpoint even when the site is replicated', async () => {
    useMinWidth(1024).value = false
    const { wrapper, siteStore } = await mountHeaderNav()
    siteStore.isReplicationEnabled = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.replication-banner').exists()).toBe(false)
  })
})

/**
 * OpenProject #2610: the logo button was the one thing in this 64px bar NOT on the shared
 * `header-nav-btn` band -- it carried `dense flat` and nothing else, so `WBtn`'s own dense sizing
 * drew a rounded box around the mark and lit only that box on hover, visibly unlike the five flush
 * squares at the opposite end of the same toolbar (and `AccountMenu`'s avatar, which
 * `AdminLayout.test.js` already pins to the same class).
 *
 * `_base.css`'s `.w-btn.header-nav-btn` is not loaded here -- these are component tests, not the
 * real-Chromium harness -- so the class itself is the contract asserted, exactly as
 * `AdminLayout.test.js` asserts it for the account button rather than measuring a box.
 */
describe('HeaderNav logo button hover target (OpenProject #2610)', () => {
  function findHomeButton(wrapper) {
    return wrapper.find('[aria-label="common.header.home"]')
  }

  it('draws the logo on the shared 64x64 header-nav-btn band', async () => {
    const { wrapper } = await mountHeaderNav()

    const homeButton = findHomeButton(wrapper)
    expect(homeButton.exists()).toBe(true)
    expect(homeButton.classes()).toContain('header-nav-btn')
  })

  it('drops `dense`, whose sizing the band overrides anyway, so the two cannot disagree', async () => {
    const { wrapper } = await mountHeaderNav()

    const homeButton = wrapper
      .findAllComponents(WBtn)
      .find((btn) => btn.attributes('aria-label') === 'common.header.home')
    expect(homeButton).toBeTruthy()
    expect(homeButton.props('dense')).toBe(false)
  })

  it('fills the full 64px band with the mark, in both logo branches', async () => {
    const { wrapper, siteStore } = await mountHeaderNav()

    // `logoText: true` (the store default) puts the mark in a squared 64px avatar beside the wordmark
    expect(findHomeButton(wrapper).find('.w-avatar').attributes('style')).toContain('64px')

    siteStore.logoText = false
    await wrapper.vm.$nextTick()

    // Without the wordmark it is a bare image, sized by its own height instead
    expect(findHomeButton(wrapper).find('img').attributes('style')).toContain('64px')
  })
})

/**
 * OpenProject #2904/#2928: on a narrow viewport the sidebar's opener is an inline toggle at the
 * head of this bar -- ahead of the logo, pushing the wordmark right -- rather than the floating
 * bottom-left corner disc `MainLayout` used to draw. `HeaderNav` stays content-only (it is also
 * mounted by `pages/Search.vue`, which has no sidebar), so the layout decides WHEN the toggle shows
 * through the `showSidebarToggle` prop (its existing `showSidebarBtn` breakpoint condition,
 * unchanged) and answers the click through the `openSidebar` emit.
 */
describe('HeaderNav inline sidebar toggle (OpenProject #2928)', () => {
  function findToggle(wrapper) {
    return wrapper.find('[aria-label="common.sidebar.mainMenu"]')
  }

  it('renders no toggle by default -- a header with no sidebar to open (Search.vue) never shows one', async () => {
    const { wrapper } = await mountHeaderNav()

    expect(findToggle(wrapper).exists()).toBe(false)
  })

  it('renders the toggle on the header-nav-btn band, ahead of the logo, when asked to', async () => {
    const { wrapper } = await mountHeaderNav()
    await wrapper.setProps({ showSidebarToggle: true })

    const toggle = findToggle(wrapper)
    expect(toggle.exists()).toBe(true)
    expect(toggle.classes()).toContain('header-nav-btn')
    expect(toggle.find('[data-icon="tabler:menu-2"]').exists()).toBe(true)

    // -> Ahead of the logo in document order, so the wordmark is what gets pushed right
    const homeButton = wrapper.find('[aria-label="common.header.home"]')
    expect(
      toggle.element.compareDocumentPosition(homeButton.element) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('emits openSidebar on click, leaving the opening itself to the layout', async () => {
    const { wrapper } = await mountHeaderNav()
    await wrapper.setProps({ showSidebarToggle: true })

    await findToggle(wrapper).trigger('click')

    expect(wrapper.emitted('openSidebar')).toHaveLength(1)
  })
})

/**
 * OpenProject #3313: the Graph nav button branches on whether `/_graph` is already open -- a plain
 * `@click` handler (`onGraphNavClick`) rather than a static `to`, so it is no longer a router-link
 * and these assert the router calls it makes directly, rather than a `to`/`href` prop that no longer
 * exists on this button.
 *
 * `mountHeaderNav({ routes, initialPath })`'s stub content-page route mirrors `router/routes.js`'s
 * own STANDARD PAGE CATCH-ALL: `meta.contentPage: true` is what `onGraphNavClick()` actually reads
 * to decide whether `pageStore.path` is trustworthy (OpenProject #2527's staleness reasoning).
 */
describe('HeaderNav Graph nav button branching (OpenProject #3313)', () => {
  const CONTENT_ROUTE = {
    path: '/:catchAll(.*)*',
    meta: { contentPage: true },
    component: { template: '<div />' }
  }

  function findGraphButton(wrapper) {
    return wrapper.find('[aria-label="common.header.graph"]')
  }

  it('renders as a plain button, not a router-link, since its destination branches on the route', async () => {
    const { wrapper, siteStore } = await mountHeaderNav({ routes: ['/', '/_graph'] })
    siteStore.features.browse = true
    await wrapper.vm.$nextTick()

    const button = findGraphButton(wrapper)
    expect(button.exists()).toBe(true)
    expect(button.element.tagName).toBe('BUTTON')
  })

  it('from an ordinary content page, opens the graph rooted on the page being read', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({
      initialPath: '/docs/setup',
      routes: ['/', '/_graph', CONTENT_ROUTE]
    })
    siteStore.features.browse = true
    const pageStore = usePageStore()
    pageStore.path = 'docs/setup'
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'docs/setup' } })
  })

  it('from a non-content route, opens the graph with no path query param -- pageStore.path there is stale leftover, not "nothing"', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({ routes: ['/', '/_graph'] })
    siteStore.features.browse = true
    const pageStore = usePageStore()
    // -> Stale leftover from a previously-read content page -- must not leak into the query here.
    pageStore.path = 'docs/setup'
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/_graph')
  })

  it('clicked again from inside /_graph, exits back to the route that was open before the graph', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({
      initialPath: '/docs/setup',
      routes: ['/', '/_graph', CONTENT_ROUTE]
    })
    siteStore.features.browse = true
    await wrapper.vm.$nextTick()

    await router.push('/_graph?path=docs/setup')
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/docs/setup')
  })

  it('exits to the route entered before the graph, not wherever the in-graph root query has since moved via the sidebar', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({
      initialPath: '/docs/setup',
      routes: ['/', '/_graph', CONTENT_ROUTE]
    })
    siteStore.features.browse = true
    await wrapper.vm.$nextTick()

    await router.push('/_graph?path=docs/setup')
    // -> Simulates `navSidebarDestination.js#graphSidebarBranch`'s own `router.replace()` moving the
    //    graph's root while the reader stays in graph mode.
    await router.replace('/_graph?path=other/page')
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/docs/setup')
  })
})
