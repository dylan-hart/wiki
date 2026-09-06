import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MainLayout from './MainLayout.vue'
import FooterNav from '@/components/FooterNav.vue'
import routes from '@/router/routes.js'

import { createTestRouter } from '../../test/router.js'
import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: true,
  MainOverlayDialog: true
}

/**
 * Regression coverage for OpenProject #2512: loading or SPA-navigating to a non-content-page route
 * (the knowledge graph chief among them) used to collapse the sidebar to its 56px mini rail, because
 * `isSidebarMini`'s `!pageStore.navigationId` fallback -- meant to catch a CONTENT page that hasn't
 * told the store which menu it belongs to yet -- fired on every OTHER route too, since those never
 * call `pageStore.pageLoad()` (the only thing that ever sets `navigationId`) and so just see whatever
 * a previously-viewed content page left there: `null` on a fresh store, or a stale id carried over
 * from an earlier SPA navigation. Fixed by scoping that fallback to `route.meta.contentPage`
 * (`router/routes.js`), so a route with no navigation opinion of its own gets the normal expanded
 * sidebar instead.
 *
 * Real routes from the app's own route table drive each case (not hand-rolled stub routes), since the
 * bug is precisely about which of those routes carry `meta.contentPage` -- a stub route list would
 * hide a regression where a route's flag drifts from what this test expects.
 */
async function mountLayout(path, options = {}) {
  const router = await createTestRouter(routes, path)

  return mountWithApp(MainLayout, { router, stubs: LAYOUT_STUBS, ...options })
}

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
 * Regression coverage for OpenProject #2513: the mini (56px icon-rail) sidebar had no way back to
 * full width once a page's own `navigationMode` (or the non-content-route fallback) collapsed it --
 * `isSidebarMini` was a read-only computed with no UI toggle reading or writing it. `MainLayout` now
 * offers a session-scoped override: an "Expand Sidebar" button in the mini rail, and a matching
 * "Collapse Sidebar" control back in the expanded sidebar's own chrome, persisted to
 * `sessionStorage` so it survives navigating to another page (or a reload of the same tab) without
 * becoming a permanent cross-session preference.
 *
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia` -- stubbed matching wide throughout, so
 * `WDrawer` renders its sidebar column rather than the narrow-viewport overlay (see
 * `HeaderNav.test.js` for the same pattern).
 */
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  // -> Node's native `sessionStorage` global is one process-wide instance -- not rebuilt per test the
  //    way `test/setup.js` rebuilds `localStorage`, so a value written by one test would otherwise
  //    leak into the next one in this file.
  sessionStorage.clear()
})

afterEach(() => {
  sessionStorage.clear()
})

const messages = {
  common: {
    actions: { skipToContent: 'Skip to content' },
    sidebar: {
      browse: 'Browse',
      collapse: 'Collapse Sidebar',
      editNav: 'Edit Nav',
      expand: 'Expand Sidebar',
      mainMenu: 'Main Menu',
      switchLocale: 'Switch Locale'
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
    // -> The override flag can still be true from a previous mini page this session; it must stay a
    //    no-op here rather than growing a stray collapse control on an ordinary page.
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

    // Simulate landing on a different page that also forces mini navigation -- the override must
    // still hold, since it is scoped to the reader's session, not to the one page it was set on.
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

/**
 * OpenProject #2720, Dylan's 2026-09-06 hands-on review (note 6, first half): the Edit Nav control
 * drew `tabler:steering-wheel` (an odd, non-obvious glyph for "edit the navigation tree") inside a
 * `w-bar dense`, whose own translucent black wash and forced 8px button label read as a "dark muddy"
 * strip out of step with the rest of the sidebar's chrome.
 */
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
    // -> Scoped through the button itself, not just the bar: `nav-edit-menu`'s own popup content
    //    sits in the same subtree and carries icons of its own.
    const editNavBtn = bar.findComponent({ name: 'WBtn' })
    expect(editNavBtn.findComponent({ name: 'WIcon' }).props('name')).toBe('tabler:list-tree')
  })

  it('draws tabler:list-tree in the collapsed mini-rail variant too', async () => {
    // -> The mini rail only renders once something has forced the sidebar into its 56px icon-only
    //    mode -- a page-level `navigationMode: 'hide'` is the ordinary way that happens (see the
    //    #2513 suite above).
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
    // -> happy-dom reports an unset `background-color` as an empty string rather than resolving it
    //    to its initial value; either way, the important thing asserted here is that nothing set it
    //    to WBar's own translucent wash (`rgb(0 0 0 / 0.2)`).
    expect(getComputedStyle(bar.element).backgroundColor).toMatch(
      /^(|rgba\(0, 0, 0, 0\)|transparent)$/
    )
  })

  /**
   * The bar's height is built to match `.site-footer`'s (`FooterNav.vue`) -- the "Powered by
   * Cardinal.js" band at the foot of the article column -- via an invisible spacer sharing the
   * SAME font stack, size and vertical padding `.site-footer` renders its own text with, rather
   * than a pixel value copied from one measurement. Asserted here as a live comparison between the
   * two REAL components' own computed styles (both mounted under this suite's `test.css: true`
   * pipeline), so a future edit to either side's padding/font-size that breaks the match fails this
   * test instead of silently drifting -- `getBoundingClientRect` itself is not asked here, since
   * neither jsdom nor happy-dom runs a layout engine (see `test/realGridLayout.js`'s own header
   * comment); the box-model DECLARATIONS that determine the rendered height are what is compared.
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

/**
 * OpenProject #2746: the reader-facing navbar's `<w-drawer>` never passed `bordered`, unlike
 * `AdminLayout.vue`'s (`bordered` since before the Quasar-to-native-components migration), so the
 * sidebar drew with no hairline separating it from the content column. `WDrawer.vue`'s `bordered`
 * prop already resolves a side-aware class (`border-e` on the left-hand default, `border-s` when
 * `siteStore.theme.sidebarPosition` flips the drawer to the right) plus its `dark:` counterpart onto
 * the `<aside class="w-drawer">` element itself -- asserted there rather than on `.bg-sidebar` (the
 * caller's own class), since `@vue/test-utils` stubs the drawer's root `<transition>` by default and
 * fallthrough attrs land on that stub, not on the real element, under test.
 */
describe('MainLayout sidebar border (OpenProject #2746)', () => {
  it('passes bordered through to the drawer, drawing the content-facing hairline on the default (left) side', async () => {
    const { wrapper } = await mountLayout('/')

    const drawer = wrapper.get('aside.w-drawer')
    expect(drawer.classes()).toContain('border-e')
    expect(drawer.classes()).toContain('border-black/12')
    expect(drawer.classes()).toContain('dark:border-white/15')
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
