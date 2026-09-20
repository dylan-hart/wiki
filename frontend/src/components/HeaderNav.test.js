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
 * uncollapsed button row renders rather than `HeaderActionsMenu`'s overflow menu.
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
 * `matchMedia` is stubbed `matches: false` here, unlike the file's wide default, so
 * `isSearchCollapsed` is true and `HeaderNav`'s own handler owns the shortcut rather than
 * `HeaderSearch` (which is unmounted below 600px).
 *
 * `composables/screen.js`'s `useMinWidth` caches one `matchMedia` listener per breakpoint at MODULE
 * scope for the file's lifetime, so this block has to mount first or it inherits whatever an earlier
 * mount cached. Declared first in the file for exactly that reason.
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

describe('HeaderNav "Browse by tags" entry point (OpenProject #1218)', () => {
  it('no longer renders its own link to /_tags -- that now lives in HeaderSearch', async () => {
    const { wrapper } = await mountHeaderNav()

    const tagsLink = wrapper.findAll('a').find((a) => a.attributes('href') === '/_tags')
    expect(tagsLink).toBeFalsy()
  })
})

/**
 * The badge counts unread page-watch notifications, so the button carrying it has to open onto the
 * section that lists them -- the Inbox overlay's Watching tab.
 */
describe('HeaderNav inbox badge destination (OpenProject #2024)', () => {
  it('opens the Inbox overlay onto the Watching tab from the badged inbox button', async () => {
    const { wrapper, siteStore, userStore } = await mountHeaderNav()
    /*
      `useMinWidth`'s shared refs (`composables/screen.js`) are cached by whichever test asks for
      the 600/900px breakpoints FIRST -- the collapsed-search block above pins them narrow, and the
      top-level `beforeEach` only affects a NEW `matchMedia` call, not an already-cached ref. Set
      directly here because this button renders only in the wide branch.
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
 * `_base.css`'s `.w-btn.header-nav-btn` is not loaded here -- these are component tests, not the
 * real-Chromium harness -- so the class itself is the contract asserted rather than a measured box.
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
    expect(homeButton.classes()).toContain('flush-hover-btn')
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

    // -> `logoText: true` is the store default: the mark sits in a squared avatar beside the wordmark
    expect(findHomeButton(wrapper).find('.w-avatar').attributes('style')).toContain('64px')

    siteStore.logoText = false
    await wrapper.vm.$nextTick()

    expect(findHomeButton(wrapper).find('img').attributes('style')).toContain('64px')
  })
})

/**
 * `HeaderNav` stays content-only -- `pages/Search.vue` mounts it too, with no sidebar to open -- so
 * the layout decides WHEN the toggle shows (`showSidebarToggle`) and answers the click
 * (`openSidebar`).
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
    expect(toggle.classes()).toContain('flush-hover-btn')
    expect(toggle.find('[data-icon="tabler:menu-2"]').exists()).toBe(true)

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
 * The stub content-page route mirrors `router/routes.js`'s own standard page catch-all:
 * `meta.contentPage: true` is what `onGraphNavClick()` reads to decide whether `pageStore.path` is
 * trustworthy.
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

  it("from an ordinary content page, opens the graph rooted on the page's nearest containing folder, not the page itself (OpenProject #3337)", async () => {
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

    expect(pushSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'docs' } })
  })

  it('from a top-level content page, anchors on the root -- an explicit empty-string sentinel, not an omitted param (OpenProject #3337)', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({
      initialPath: '/standalone',
      routes: ['/', '/_graph', CONTENT_ROUTE]
    })
    siteStore.features.browse = true
    const pageStore = usePageStore()
    pageStore.path = 'standalone'
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: '' } })
  })

  it('from a non-content route, opens the graph with no path query param -- pageStore.path there is stale leftover, not "nothing"', async () => {
    const { wrapper, siteStore, router } = await mountHeaderNav({ routes: ['/', '/_graph'] })
    siteStore.features.browse = true
    const pageStore = usePageStore()
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
    // -> Stands in for `navSidebarDestination.js#graphSidebarBranch`'s own `router.replace()` moving
    //    the graph's root while the reader stays in graph mode.
    await router.replace('/_graph?path=other/page')
    await wrapper.vm.$nextTick()

    const pushSpy = vi.spyOn(router, 'push')
    await findGraphButton(wrapper).trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/docs/setup')
  })
})
