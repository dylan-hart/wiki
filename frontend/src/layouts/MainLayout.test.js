import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MainLayout from './MainLayout.vue'
import FooterNav from '@/components/FooterNav.vue'
import LocaleSelectorMenu from '@/components/LocaleSelectorMenu.vue'
import NavBrowseMenu from '@/components/NavBrowseMenu.vue'
import WMenu from '@/components/shared/WMenu.vue'
import routes from '@/router/routes.js'
import { useCommonStore } from '@/stores/common'
import { useMinWidth } from '@/composables/screen'
import { useDirection } from '@/composables/direction'

import { createTestRouter } from '../../test/router.js'
import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: true,
  MainOverlayDialog: true
}

/**
 * Drives each case from the app's own route table rather than stub routes: the sidebar-mini
 * fallback keys off `route.meta.contentPage`, so stub routes would hide a drifted flag.
 */
async function mountLayout(path, options = {}) {
  const router = await createTestRouter(routes, path)

  return mountWithApp(MainLayout, { router, stubs: LAYOUT_STUBS, ...options })
}

/**
 * Must stay the FIRST describe in this file: later ones mount with `attachTo: document.body` and
 * never unmount, and `useDirection()`'s ref is module-level -- flipping direction after they have
 * run re-triggers those now-parentless instances and crashes on a null `insertBefore`.
 */
describe('MainLayout sidebar w-menu anchors (RTL mirroring, OpenProject #3196)', () => {
  async function mountMiniSidebar() {
    const router = await createTestRouter(['/'])
    return mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: (siteStore) => {
          siteStore.features.browse = true
        },
        user: { authenticated: true, permissions: ['manage:navigation'] },
        page: (store) => store.$patch({ navigationId: 1, navigationMode: 'hide' })
      },
      stubs: { HeaderNav: true, MainOverlayDialog: true, NavSidebar: true }
    })
  }

  async function mountFullSidebar() {
    const router = await createTestRouter(['/'])
    return mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        user: { authenticated: true, permissions: ['manage:navigation'] }
      },
      stubs: { HeaderNav: true, MainOverlayDialog: true, NavSidebar: true }
    })
  }

  afterEach(() => {
    // -> Module-level ref shared across test files; leaving it flipped bleeds into the next test
    useDirection().set(false)
  })

  it("anchors the mini rail's locale/browse popups to the trailing (right) edge under ltr", async () => {
    const { wrapper } = await mountMiniSidebar()

    const localeMenu = wrapper.findComponent(LocaleSelectorMenu)
    expect(localeMenu.props('anchor')).toBe('top right')
    expect(localeMenu.props('self')).toBe('top left')

    const browseMenu = wrapper.findComponent(NavBrowseMenu)
    expect(browseMenu.props('anchor')).toBe('top right')
    expect(browseMenu.props('self')).toBe('top left')

    wrapper.unmount()
  })

  it("mirrors the mini rail's locale/browse popups to the trailing (left) edge under rtl", async () => {
    useDirection().set(true)
    const { wrapper } = await mountMiniSidebar()

    const localeMenu = wrapper.findComponent(LocaleSelectorMenu)
    expect(localeMenu.props('anchor')).toBe('top left')
    expect(localeMenu.props('self')).toBe('top right')

    const browseMenu = wrapper.findComponent(NavBrowseMenu)
    expect(browseMenu.props('anchor')).toBe('top left')
    expect(browseMenu.props('self')).toBe('top right')

    wrapper.unmount()
  })

  it("anchors the mini rail's Edit Nav popup under ltr, and mirrors it under rtl", async () => {
    const { wrapper } = await mountMiniSidebar()

    const miniEditNavMenu = wrapper.get(`[aria-label="${messages.common.sidebar.editNav}"]`)
    const ltrMenu = miniEditNavMenu.findComponent(WMenu)
    expect(ltrMenu.props('anchor')).toBe('top right')
    expect(ltrMenu.props('self')).toBe('bottom left')

    wrapper.unmount()

    useDirection().set(true)
    const { wrapper: rtlWrapper } = await mountMiniSidebar()
    const rtlMenu = rtlWrapper
      .get(`[aria-label="${messages.common.sidebar.editNav}"]`)
      .findComponent(WMenu)
    expect(rtlMenu.props('anchor')).toBe('top left')
    expect(rtlMenu.props('self')).toBe('bottom right')

    rtlWrapper.unmount()
  })

  it("anchors the full sidebar footer's Edit Nav popup under ltr, and mirrors it under rtl", async () => {
    const { wrapper } = await mountFullSidebar()

    const ltrMenu = wrapper.get('.sidebar-footerbtns').findComponent(WMenu)
    expect(ltrMenu.props('anchor')).toBe('top left')
    expect(ltrMenu.props('self')).toBe('bottom left')

    wrapper.unmount()

    useDirection().set(true)
    const { wrapper: rtlWrapper } = await mountFullSidebar()
    const rtlMenu = rtlWrapper.get('.sidebar-footerbtns').findComponent(WMenu)
    expect(rtlMenu.props('anchor')).toBe('top right')
    expect(rtlMenu.props('self')).toBe('bottom right')

    rtlWrapper.unmount()
  })
})

describe('MainLayout sidebar-mini fallback (OpenProject #2512)', () => {
  it('stays mini on a content page route with no navigationId yet (fresh store / direct load)', async () => {
    const { wrapper } = await mountLayout('/some/wiki/page')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
  })

  it('expands once the content page route has a navigationId', async () => {
    const { wrapper, pageStore } = await mountLayout('/some/wiki/page')

    pageStore.navigationId = 'nav-1'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('does NOT go mini on a non-content route with no navigationId (the graph, direct load)', async () => {
    const { wrapper } = await mountLayout('/_graph')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('does NOT go mini on a non-content route carrying a STALE navigationId left by a prior page', async () => {
    const router = await createTestRouter(routes, '/some/wiki/page')
    const { wrapper } = mountWithApp(MainLayout, {
      router,
      stubs: LAYOUT_STUBS,
      stores: { page: { navigationId: 'stale-nav-from-last-page' } }
    })

    await router.push('/_graph')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('other non-content routes (tags browse) also skip the fallback', async () => {
    const { wrapper } = await mountLayout('/_tags')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('still goes mini on a content page whose author set navigationMode to hide, regardless of navigationId', async () => {
    const { wrapper, pageStore } = await mountLayout('/some/wiki/page')

    pageStore.$patch({ navigationId: 'nav-1', navigationMode: 'hide' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
  })
})

/**
 * `useMinWidth` calls `window.matchMedia`; stubbed matching wide throughout so `WDrawer` renders
 * its sidebar column rather than the narrow-viewport overlay.
 */
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  // -> Node's native `sessionStorage` is one process-wide instance -- `test/setup.js` rebuilds
  //    `localStorage` per test but not this, so a value written here leaks into the next test
  sessionStorage.clear()
})

afterEach(() => {
  sessionStorage.clear()
})

const messages = {
  common: {
    actions: { skipToContent: 'Skip to content', returnToTop: 'Return to top' },
    sidebar: {
      browse: 'Browse',
      collapse: 'Collapse Sidebar',
      editNav: 'Edit Nav',
      expand: 'Expand Sidebar',
      mainMenu: 'Main Menu',
      switchLocale: 'Switch Locale',
      top: 'Top'
    }
  }
}

async function mountMainLayout({ navigationId = null, navigationMode = 'inherit' } = {}) {
  const router = await createTestRouter(['/'])

  return mountWithApp(MainLayout, {
    messages,
    router,
    stores: {
      page: (store) => {
        store.$patch({ navigationId, navigationMode })
      }
    },
    stubs: {
      HeaderNav: true,
      MainOverlayDialog: true,
      NavSidebar: true
    }
  })
}

describe('MainLayout sidebar mini-mode expand override (OpenProject #2513)', () => {
  it('renders the mini rail with an Expand Sidebar button when the page forces mini', async () => {
    const { wrapper } = await mountMainLayout({ navigationMode: 'hide', navigationId: 1 })

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
    const expandBtn = wrapper.find('[aria-label="Expand Sidebar"]')
    expect(expandBtn.exists()).toBe(true)
  })

  it('does not render the mini rail (or its expand button) when the page has full navigation', async () => {
    const { wrapper } = await mountMainLayout({ navigationMode: 'inherit', navigationId: 1 })

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Expand Sidebar"]').exists()).toBe(false)
  })

  it('expands to full width once the Expand Sidebar button is clicked', async () => {
    const { wrapper } = await mountMainLayout({ navigationMode: 'hide', navigationId: 1 })

    await wrapper.find('[aria-label="Expand Sidebar"]').trigger('click')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'NavSidebar' }).exists()).toBe(true)
  })

  it('offers a Collapse Sidebar control once expanded via the override, and it collapses back', async () => {
    const { wrapper } = await mountMainLayout({ navigationMode: 'hide', navigationId: 1 })

    await wrapper.find('[aria-label="Expand Sidebar"]').trigger('click')
    const collapseBtn = wrapper.find('[aria-label="Collapse Sidebar"]')
    expect(collapseBtn.exists()).toBe(true)

    await collapseBtn.trigger('click')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Expand Sidebar"]').exists()).toBe(true)
  })

  it('does not offer a Collapse Sidebar control on a page that was never mini to begin with', async () => {
    // -> The override can still be true from an earlier mini page this session; it must no-op here
    sessionStorage.setItem('sidebarExpandOverride', 'true')

    const { wrapper } = await mountMainLayout({ navigationMode: 'inherit', navigationId: 1 })

    expect(wrapper.find('[aria-label="Collapse Sidebar"]').exists()).toBe(false)
    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('persists the override across a simulated route change to another mini-mode page', async () => {
    const { wrapper, pageStore } = await mountMainLayout({
      navigationMode: 'hide',
      navigationId: 1
    })

    await wrapper.find('[aria-label="Expand Sidebar"]').trigger('click')
    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)

    pageStore.$patch({ navigationId: 2, navigationMode: 'hideExact' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
    expect(sessionStorage.getItem('sidebarExpandOverride')).toBe('true')
  })

  it('reads a previously-stored override from sessionStorage on mount (session persistence)', async () => {
    sessionStorage.setItem('sidebarExpandOverride', 'true')

    const { wrapper } = await mountMainLayout({ navigationMode: 'hide', navigationId: 1 })

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Collapse Sidebar"]').exists()).toBe(true)
  })
})

async function mountMainLayoutWithEditNav() {
  const router = await createTestRouter(['/'])

  return mountWithApp(MainLayout, {
    messages,
    router,
    stores: {
      user: { authenticated: true, permissions: ['manage:navigation'] }
    },
    stubs: {
      HeaderNav: true,
      MainOverlayDialog: true,
      NavSidebar: true
    },
    attachTo: document.body
  })
}

describe('MainLayout edit-nav control (OpenProject #2720)', () => {
  it('draws tabler:list-tree in the full sidebar footer bar, not the old steering wheel', async () => {
    const { wrapper } = await mountMainLayoutWithEditNav()

    const bar = wrapper.find('.sidebar-footerbtns')
    expect(bar.exists()).toBe(true)
    // -> Scoped through the button, not the bar: the nav-edit popup content sits in the same
    //    subtree and carries icons of its own
    const editNavBtn = bar.findComponent({ name: 'WBtn' })
    expect(editNavBtn.findComponent({ name: 'WIcon' }).props('name')).toBe('tabler:list-tree')
  })

  it('draws tabler:list-tree in the collapsed mini-rail variant too', async () => {
    const router = await createTestRouter(['/'])
    const { wrapper } = mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        user: { authenticated: true, permissions: ['manage:navigation'] },
        page: { navigationId: 1, navigationMode: 'hide' }
      },
      stubs: { HeaderNav: true, MainOverlayDialog: true, NavSidebar: true }
    })

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
    const miniEditNavBtn = wrapper.find(`[aria-label="${messages.common.sidebar.editNav}"]`)
    expect(miniEditNavBtn.exists()).toBe(true)
    expect(miniEditNavBtn.findComponent({ name: 'WIcon' }).props('name')).toBe('tabler:list-tree')
  })

  it('carries no background of its own (the old w-bar wash is gone)', async () => {
    const { wrapper } = await mountMainLayoutWithEditNav()

    const bar = wrapper.get('.sidebar-footerbtns')
    // -> happy-dom reports an unset `background-color` as an empty string rather than its initial
    //    value; what matters is that nothing set it to WBar's own translucent wash
    expect(getComputedStyle(bar.element).backgroundColor).toMatch(
      /^(|rgba\(0, 0, 0, 0\)|transparent)$/
    )
  })

  /**
   * Neither jsdom nor happy-dom runs a layout engine, so the box-model DECLARATIONS both real
   * components resolve are compared rather than `getBoundingClientRect`.
   */
  it('sizes its spacer from the same padding/font-size/font-family recipe as the site footer', async () => {
    const { wrapper } = await mountMainLayoutWithEditNav()
    const spacer = wrapper.get('.sidebar-footerbtns-spacer')

    const footerI18n = createTestI18n({
      common: { footerGeneric: 'Powered by {link}' }
    })
    const footerWrapper = mount(FooterNav, {
      props: { generic: true },
      global: { plugins: [footerI18n] },
      attachTo: document.body
    })

    try {
      const spacerStyle = getComputedStyle(spacer.element)
      const footerStyle = getComputedStyle(footerWrapper.element)

      expect(spacerStyle.paddingTop).toBe(footerStyle.paddingTop)
      expect(spacerStyle.paddingBottom).toBe(footerStyle.paddingBottom)
      expect(spacerStyle.fontSize).toBe(footerStyle.fontSize)
      expect(spacerStyle.fontFamily).toBe(footerStyle.fontFamily)
    } finally {
      footerWrapper.unmount()
    }
  })
})

describe('MainLayout edit-nav site:navigation delegation (OpenProject #3380)', () => {
  async function mountLayoutForSite(storeOverrides) {
    const router = await createTestRouter(['/'])

    return mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: { id: 'site-1' },
        ...storeOverrides
      },
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true,
        NavSidebar: true
      }
    })
  }

  it('shows Edit Nav for a site:navigation-only delegate on the current site', async () => {
    const { wrapper } = await mountLayoutForSite({
      user: {
        authenticated: true,
        permissions: [],
        sitePermissions: ['site:navigation'],
        sitePermissionsSiteId: 'site-1'
      }
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-footerbtns').exists()).toBe(true)
  })

  it('hides Edit Nav for a site:navigation delegation fetched for a DIFFERENT site', async () => {
    const { wrapper } = await mountLayoutForSite({
      user: {
        authenticated: true,
        permissions: [],
        sitePermissions: ['site:navigation'],
        sitePermissionsSiteId: 'site-2'
      }
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-footerbtns').exists()).toBe(false)
  })

  it('hides Edit Nav when the user holds neither manage:navigation nor a site:navigation delegation', async () => {
    const { wrapper } = await mountLayoutForSite({
      user: { authenticated: true, permissions: [] }
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-footerbtns').exists()).toBe(false)
  })

  it('still shows Edit Nav for a global manage:navigation holder, with no sitePermissions fetched', async () => {
    const { wrapper } = await mountLayoutForSite({
      user: { authenticated: true, permissions: ['manage:navigation'] }
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-footerbtns').exists()).toBe(true)
  })

  it('fetches site permissions on mount for an authenticated user without manage:navigation', async () => {
    const { calls } = stubApi({ 'sites/site-1/userPermissions': ['site:navigation'] })

    await mountLayoutForSite({
      user: { authenticated: true, permissions: [] }
    })

    expect(calls).toContain('sites/site-1/userPermissions')
  })

  it('does not fetch site permissions for a global manage:navigation holder', async () => {
    const { calls } = stubApi({ 'sites/site-1/userPermissions': ['site:navigation'] })

    await mountLayoutForSite({
      user: { authenticated: true, permissions: ['manage:navigation'] }
    })

    expect(calls).not.toContain('sites/site-1/userPermissions')
  })

  it('does not fetch site permissions for a guest', async () => {
    const { calls } = stubApi({ 'sites/site-1/userPermissions': ['site:navigation'] })

    await mountLayoutForSite({
      user: { authenticated: false, permissions: [] }
    })

    expect(calls).not.toContain('sites/site-1/userPermissions')
  })
})

/**
 * Asserted on `<aside class="w-drawer">` rather than the caller's own `.bg-sidebar`:
 * `@vue/test-utils` stubs the drawer's root `<transition>` by default, and fallthrough attrs land
 * on that stub instead of the real element under test.
 */
describe('MainLayout sidebar border (OpenProject #2746)', () => {
  it('passes bordered through to the drawer, drawing the content-facing hairline on the default (left) side', async () => {
    const { wrapper } = await mountLayout('/')

    const drawer = wrapper.get('aside.w-drawer')
    expect(drawer.classes()).toContain('border-e')
    expect(drawer.classes()).toContain('border-hairline')
    expect(drawer.classes()).toContain('dark:border-hairline-dark')
  })

  it('flips to the logical opposite side when the site theme puts the sidebar on the right', async () => {
    const { wrapper } = await mountLayout('/', {
      stores: {
        site: (siteStore) => {
          siteStore.theme.sidebarPosition = 'right'
        }
      }
    })

    const drawer = wrapper.get('aside.w-drawer')
    expect(drawer.classes()).toContain('border-s')
    expect(drawer.classes()).not.toContain('border-e')
  })
})

describe('MainLayout reader locale/browse toolbar sizing (OpenProject #2788)', () => {
  async function mountToolbar({ navigationId = null, navigationMode = 'inherit' } = {}) {
    const router = await createTestRouter(['/'])

    return mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: (siteStore) => {
          siteStore.features.browse = true
        },
        page: (store) => {
          store.$patch({ navigationId, navigationMode })
        }
      },
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true,
        NavSidebar: true
      },
      // -> `getComputedStyle` resolves the real cascade only for an element attached to the
      //    document
      attachTo: document.body
    })
  }

  it('sizes Locale to its own content while Browse keeps flex-1 and absorbs the rest of the row', async () => {
    const { wrapper } = await mountToolbar()
    const commonStore = useCommonStore()

    const localeBtn = wrapper.get(`[aria-label="${commonStore.locale}"]`)
    const browseBtn = wrapper.get(`[aria-label="${messages.common.sidebar.browse}"]`)

    expect(localeBtn.classes()).not.toContain('flex-1')
    expect(browseBtn.classes()).toContain('flex-1')
  })

  it('renders both Locale and Browse icons at 20px, not WBtn size="sm"\'s default ~17px', async () => {
    const { wrapper } = await mountToolbar()
    const commonStore = useCommonStore()

    const localeBtn = wrapper.get(`[aria-label="${commonStore.locale}"]`)
    const browseBtn = wrapper.get(`[aria-label="${messages.common.sidebar.browse}"]`)

    expect(getComputedStyle(localeBtn.get('.w-icon').element).fontSize).toBe('20px')
    expect(getComputedStyle(browseBtn.get('.w-icon').element).fontSize).toBe('20px')
  })

  it('leaves the sibling Collapse Sidebar button out of the 20px override (out of scope)', async () => {
    sessionStorage.setItem('sidebarExpandOverride', 'true')

    const { wrapper } = await mountToolbar({ navigationMode: 'hide', navigationId: 1 })

    const collapseBtn = wrapper.get(`[aria-label="${messages.common.sidebar.collapse}"]`)
    expect(collapseBtn.classes()).not.toContain('icon-lg')
  })
})

/**
 * The `aria-label` deliberately stays lowercase -- screen readers don't need visual casing -- so
 * the uppercasing is asserted against the rendered label text, not the aria-label.
 */
describe('MainLayout reader locale button casing (OpenProject #2971)', () => {
  it('uppercases the locale code in the visible label, matching AdminLayout', async () => {
    const router = await createTestRouter(['/'])

    const { wrapper } = await mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: (siteStore) => {
          siteStore.features.browse = true
        }
      },
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true,
        NavSidebar: true,
        LocaleSelectorMenu: true
      }
    })

    // -> `mountWithApp` does not manage `commonStore`, so this reads its real default
    const commonStore = useCommonStore()
    expect(commonStore.locale).toBe('en')

    const localeBtn = wrapper.get('.sidebar-actions-locale')
    expect(localeBtn.attributes('aria-label')).toBe('en')
    // -> The label lives in WBtn's own `<span>`, a sibling of the default slot, so `span > span`
    //    is exactly the rendered label and nothing else in the button
    expect(localeBtn.find('span > span').text()).toBe('EN')
  })
})

describe('MainLayout sidebar-actions Top cell (OpenProject #2861)', () => {
  async function mountWithScrollColumn({ scrollTop = 0, routes = ['/'] } = {}) {
    const router = await createTestRouter(routes)
    const { wrapper, ...rest } = mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: (siteStore) => {
          siteStore.features.browse = true
        }
      },
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true,
        NavSidebar: true
      },
      attachTo: document.body
    })

    const scrollColumn = document.createElement('div')
    scrollColumn.className = 'page-container-scrl'
    document.body.appendChild(scrollColumn)
    Object.defineProperty(scrollColumn, 'scrollTop', {
      value: scrollTop,
      writable: true,
      configurable: true
    })
    scrollColumn.scrollTo = vi.fn()

    return { wrapper, scrollColumn, ...rest }
  }

  afterEach(() => {
    document.querySelectorAll('.page-container-scrl').forEach((el) => el.remove())
  })

  function findTopBtn(wrapper) {
    return wrapper
      .get('.sidebar-actions')
      .find(`[aria-label="${messages.common.actions.returnToTop}"]`)
  }

  it('reserves the 40x40 Top cell even when the button itself is not mounted (page at top)', async () => {
    const { wrapper } = await mountWithScrollColumn()

    const cell = wrapper.get('.sidebar-actions-top')
    expect(getComputedStyle(cell.element).width).toBe('40px')
    expect(findTopBtn(wrapper).exists()).toBe(false)
  })

  it('fades the Top button in once the scroll column passes the 150px threshold', async () => {
    const { wrapper, scrollColumn } = await mountWithScrollColumn()

    expect(findTopBtn(wrapper).exists()).toBe(false)

    scrollColumn.scrollTop = 200
    window.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()

    expect(findTopBtn(wrapper).exists()).toBe(true)
  })

  it('stays hidden at exactly the threshold and below it', async () => {
    const { wrapper, scrollColumn } = await mountWithScrollColumn()

    scrollColumn.scrollTop = 150
    window.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()

    expect(findTopBtn(wrapper).exists()).toBe(false)
  })

  it('scrolls the page column to the top, smoothly, on click', async () => {
    const { wrapper, scrollColumn } = await mountWithScrollColumn({ scrollTop: 200 })

    window.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()

    await findTopBtn(wrapper).trigger('click')

    expect(scrollColumn.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it("recomputes visibility on route change, so a new page does not inherit the old one's Top state", async () => {
    const { wrapper, scrollColumn, router } = await mountWithScrollColumn({
      scrollTop: 200,
      routes: ['/', '/some/other/page']
    })

    window.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(findTopBtn(wrapper).exists()).toBe(true)

    // -> Stands in for the new route's own scroll column starting back at the top
    scrollColumn.scrollTop = 0
    await router.push('/some/other/page')
    await wrapper.vm.$nextTick()

    expect(findTopBtn(wrapper).exists()).toBe(false)
  })

  it('sizes Locale to a fixed 72px cell, distinct from the reserved 40px Top cell', async () => {
    const { wrapper } = await mountWithScrollColumn()
    const commonStore = useCommonStore()

    const localeBtn = wrapper.get(`[aria-label="${commonStore.locale}"]`)
    expect(localeBtn.classes()).toContain('sidebar-actions-locale')
    expect(getComputedStyle(localeBtn.element).width).toBe('72px')
  })

  it('gives the strip a true 40px content interior (41px border-box)', async () => {
    const { wrapper } = await mountWithScrollColumn()

    const strip = wrapper.get('.sidebar-actions')
    expect(getComputedStyle(strip.element).height).toBe('41px')
  })
})

/**
 * This harness never loads `tailwind.css`'s token layer, so rules resolving a `var(--color-*)` are
 * asserted against the compiled stylesheet's own source text; literal, class-toggleable rules are
 * asserted live via `getComputedStyle`.
 */
describe('MainLayout sidebar-actions Ledger + Cobalt visual treatment (OpenProject #2862)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'MainLayout.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))

  async function mountStrip({ cobalt = false } = {}) {
    document.body.classList.toggle('body--cobalt', cobalt)

    const router = await createTestRouter(['/'])
    const { wrapper, ...rest } = mountWithApp(MainLayout, {
      messages,
      router,
      stores: {
        site: (siteStore) => {
          siteStore.features.browse = true
        }
      },
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true,
        NavSidebar: true
      },
      attachTo: document.body
    })

    // -> The Top button only mounts once `.page-container-scrl` has scrolled past 150px, and every
    //    test here needs it visible
    const scrollColumn = document.createElement('div')
    scrollColumn.className = 'page-container-scrl'
    document.body.appendChild(scrollColumn)
    Object.defineProperty(scrollColumn, 'scrollTop', {
      value: 200,
      writable: true,
      configurable: true
    })
    scrollColumn.scrollTo = vi.fn()
    window.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()

    return { wrapper, ...rest }
  }

  afterEach(() => {
    document.body.classList.remove('body--cobalt')
    document.querySelectorAll('.page-container-scrl').forEach((el) => el.remove())
  })

  it('gives the "TOP" label its Roboto Mono, uppercase, wide-tracking treatment', async () => {
    const { wrapper } = await mountStrip()

    const label = wrapper.get('.sidebar-actions-top .w-btn > span > span')
    const style = getComputedStyle(label.element)
    expect(style.fontWeight).toBe('600')
    expect(style.fontSize).toBe('7.5px')
    expect(style.textTransform).toBe('uppercase')
    // -> happy-dom resolves the `em` in `letter-spacing` against the element's PRIOR inherited
    //    font-size, not the 7.5px the same rule sets -- checked against the source text instead
    expect(styleBlock).toMatch(/> span > span \{[\s\S]*?letter-spacing: 0\.18em;/)
  })

  it('pins the Top arrow-up to 15px, distinct from the Locale/Browse 20px icons', async () => {
    const { wrapper } = await mountStrip()

    const topIcon = wrapper.get('.sidebar-actions-top .w-icon')
    expect(getComputedStyle(topIcon.element).fontSize).toBe('15px')
  })

  it("stacks the Top button's icon above its label instead of WBtn's default row", async () => {
    const { wrapper } = await mountStrip()

    const contentSpan = wrapper.get('.sidebar-actions-top .w-btn > span')
    expect(getComputedStyle(contentSpan.element).flexDirection).toBe('column')
  })

  it("removes the strip's own bottom rule and both cell separators under Cobalt", async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    const strip = wrapper.get('.sidebar-actions')
    expect(getComputedStyle(strip.element).borderBottomStyle).toBe('none')

    const separators = wrapper.findAll('.sidebar-actions .w-separator')
    expect(separators.length).toBeGreaterThan(0)
    for (const sep of separators) {
      expect(getComputedStyle(sep.element).display).toBe('none')
    }
  })

  it('keeps both cell separators rendered (not display: none) under Ledger', async () => {
    const { wrapper } = await mountStrip()

    const separators = wrapper.findAll('.sidebar-actions .w-separator')
    expect(separators.length).toBeGreaterThan(0)
    for (const sep of separators) {
      expect(getComputedStyle(sep.element).display).not.toBe('none')
    }
  })

  it('insets Locale and Browse into flat tiles under Cobalt', async () => {
    const { wrapper } = await mountStrip({ cobalt: true })
    const commonStore = useCommonStore()

    const localeBtn = wrapper.get(`[aria-label="${commonStore.locale}"]`)
    const browseBtn = wrapper.get(`[aria-label="${messages.common.sidebar.browse}"]`)

    for (const btn of [localeBtn, browseBtn]) {
      const style = getComputedStyle(btn.element)
      expect(style.marginTop).toBe('4px')
      expect(style.marginRight).toBe('0px')
      expect(style.marginBottom).toBe('4px')
      expect(style.marginLeft).toBe('4px')
    }
  })

  it('sizes the Top tile to fill its 40x40 cell with no padding under Cobalt', async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    const style = getComputedStyle(wrapper.get('.sidebar-actions-top .w-btn').element)
    expect(style.width).toBe('40px')
    expect(style.height).toBe('40px')
    expect(style.padding).toBe('0px')
  })

  it('sizes the Top tile to fill its 40x40 cell with no padding under Ledger', async () => {
    const { wrapper } = await mountStrip()

    const style = getComputedStyle(wrapper.get('.sidebar-actions-top .w-btn').element)
    expect(style.width).toBe('40px')
    expect(style.height).toBe('40px')
    expect(style.padding).toBe('0px')
  })

  it("gives the Top button the icon-lg class, matching Locale/Browse's shared treatment", async () => {
    const { wrapper } = await mountStrip()

    const topBtn = wrapper.get('.sidebar-actions-top .w-btn')
    expect(topBtn.classes()).toContain('icon-lg')
  })

  /**
   * The Top button is pinned to 40px inside an equally-40px cell, so `.icon-lg`'s inset margin --
   * which Locale/Browse have no fixed size to fight and simply shrink to absorb -- would push it
   * past its cell's edge instead of insetting it.
   */
  it("keeps the Top button flush with its cell under Cobalt, unlike Locale/Browse's inset margin", async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    const style = getComputedStyle(wrapper.get('.sidebar-actions-top .w-btn').element)
    expect(style.marginTop).toBe('0px')
    expect(style.marginRight).toBe('0px')
    expect(style.marginBottom).toBe('0px')
    expect(style.marginLeft).toBe('0px')
  })

  it("colours the Top icon from the sidebar-icon token under Cobalt, not #3109's bespoke pink", async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    expect(styleBlock).not.toMatch(/#ff8f97/)

    const topIcon = wrapper.get('.sidebar-actions-top .w-icon')
    const iconRuleWins =
      /\.sidebar-actions \.icon-lg \{[\s\S]*?\.w-icon \{\s*color: var\(--color-sidebar-icon\);\s*\}/
    expect(styleBlock).toMatch(iconRuleWins)
    // -> The icon rule is scoped inside `body.body--cobalt`, applied after the Top cell's own
    //    unscoped rule -- checked live rather than re-deriving the cascade by hand
    expect(getComputedStyle(topIcon.element).fontSize).toBe('15px')
  })

  it('resets the unscoped Ledger white-plate background to transparent under Cobalt', async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    const style = getComputedStyle(wrapper.get('.sidebar-actions-top .w-btn').element)
    // -> `#0000`, not the `transparent` keyword: lightningcss (wired into `vitest.config.js` to
    //    downlevel native CSS nesting for happy-dom) canonicalizes color keywords to shortest hex
    expect(style.backgroundColor).toBe('#0000')
  })

  it("resolves Ledger's cell-separator hairline colour from the light/dark hairline tokens", () => {
    expect(styleBlock).toMatch(
      /\.sidebar-actions \.w-separator \{\s*--w-hairline-color: var\(--color-hairline\);\s*\}/
    )
    expect(styleBlock).toMatch(
      /\.body--dark:not\(\.body--cobalt\) \{[\s\S]*?\.sidebar-actions \.w-separator \{\s*--w-hairline-color: var\(--color-hairline-dark\);\s*\}/
    )
  })

  it('draws the Top plate/glyph from the accent tokens, light and dark', () => {
    expect(styleBlock).toMatch(
      /background-color: var\(--color-white\);\s*color: var\(--color-accent\);/
    )
    expect(styleBlock).toMatch(
      /background-color: var\(--color-dark-2\);\s*color: var\(--color-accent-dark\);/
    )
    expect(styleBlock).toMatch(/font-family: var\(--font-mono\);/)
  })

  it("colours Cobalt's Locale/Browse icon from the sidebar-icon token, distinct from the label", () => {
    expect(styleBlock).toMatch(
      /\.sidebar-actions \.icon-lg \{[\s\S]*?\.w-icon \{\s*color: var\(--color-sidebar-icon\);\s*\}/
    )
  })
})

/**
 * `useMinWidth` caches its `matchMedia` refs module-wide (`composables/screen.js`), so a fresh
 * `matchMedia` mock cannot reach a breakpoint another test in this file already cached -- the refs
 * are set directly instead.
 */
describe('MainLayout has no corner scroll-to-top button at any width (OpenProject #2894)', () => {
  afterEach(() => {
    useMinWidth(1200).value = true
    useMinWidth(750).value = true
  })

  it.each([
    ['>=1200px, where the sidebar has a column of its own', true, true],
    ['750-1199px, where the sidebar overlays the page', false, true],
    ['below 750px, where the TOC-panel opener keeps the corner', false, false]
  ])(
    'does not render a bottom-right corner scroll-to-top button %s',
    async (_label, wide, tocPanel) => {
      useMinWidth(1200).value = wide
      useMinWidth(750).value = tocPanel

      const { wrapper } = await mountLayout('/')

      // -> Asserted on the corner class, not the `returnToTop` aria-label: the sidebar's own Top
      //    button shares that label
      expect(wrapper.find('.corner-btn--right').exists()).toBe(false)
    }
  )
})

/**
 * This layout owns when the toggle shows (`showSidebarBtn`) and what a click does
 * (`openSidebar()`), handing both to `HeaderNav` as a prop and an emit -- so with the header
 * stubbed, that prop and the drawer's reaction to that emit are the contract. `useMinWidth` refs
 * are set directly, for the same cached-`matchMedia` reason as the suite above.
 */
describe('MainLayout inline sidebar toggle replaces the corner FAB (OpenProject #2928)', () => {
  afterEach(() => {
    useMinWidth(1200).value = true
  })

  function headerNav(wrapper) {
    return wrapper.findComponent({ name: 'HeaderNav' })
  }

  it('draws no floating corner opener on a narrow viewport any more', async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')

    expect(wrapper.find('.corner-btn--left').exists()).toBe(false)
    expect(wrapper.find('[data-icon="tabler:menu-2"]').exists()).toBe(false)
  })

  it('asks the header for the toggle on a narrow viewport, on the existing showSidebarBtn condition', async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')

    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(true)
  })

  it('does not ask for it on a wide viewport, where the sidebar has a column of its own', async () => {
    useMinWidth(1200).value = true

    const { wrapper } = await mountLayout('/')

    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(false)
  })

  it('does not ask for it when the site has no sidebar at all', async () => {
    useMinWidth(1200).value = false

    const { wrapper, siteStore } = await mountLayout('/')
    siteStore.showSideNav = false
    await wrapper.vm.$nextTick()

    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(false)
  })

  it("opens the overlaying sidebar through the header's openSidebar emit, and keeps the toggle mounted while it is open", async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')
    const drawer = wrapper.findComponent({ name: 'WDrawer' })
    expect(drawer.props('modelValue')).toBe(false)

    headerNav(wrapper).vm.$emit('openSidebar')
    await wrapper.vm.$nextTick()

    expect(drawer.props('modelValue')).toBe(true)
    // -> Still asked for, so the header keeps its 64px slot and the logo does not slide left;
    //    the drawer/scrim may cover it
    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(true)

    // -> The scrim is what closes it
    drawer.vm.$emit('update:modelValue', false)
    await wrapper.vm.$nextTick()

    expect(drawer.props('modelValue')).toBe(false)
    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(true)
  })
})
