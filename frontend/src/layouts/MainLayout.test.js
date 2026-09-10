import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MainLayout from './MainLayout.vue'
import FooterNav from '@/components/FooterNav.vue'
import routes from '@/router/routes.js'
import { useCommonStore } from '@/stores/common'
import { useMinWidth } from '@/composables/screen'

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

/**
 * OpenProject #2788: the reader-facing Locale button in `.sidebar-actions` carried the same
 * `flex-1` class as Browse, splitting the row 50/50 regardless of either label's actual length --
 * unlike `AdminLayout.vue`'s standalone, content-sized locale button. Both icons also rendered at
 * WBtn's own `size="sm"` ratio (~17px), undersized next to the label. Fixed by dropping `flex-1`
 * from Locale (Browse keeps it, so it absorbs the width Locale no longer claims) and pinning both
 * icons to 20px via a `.icon-lg` marker class scoped to this toolbar only -- not the sibling
 * "Collapse Sidebar" button, which shares the same `.sidebar-actions` wrapper but is out of scope.
 */
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
      // -> `getComputedStyle` only resolves the real cascade (including the `<style lang="scss">`
      //    rule this suite asserts against) for an element actually attached to the document, the
      //    same reason the sibling `.sidebar-footerbtns-spacer` suite above attaches too.
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
 * OpenProject #2776 ("History + File manager: diff against Cobalt mockups, fix gaps"). Diffing the
 * File Manager and Page History overlays against their Cobalt mockups (`Cardinal Wiki - File
 * Manager 3x - Cobalt.dc.html`, `Cardinal Wiki - History 3x - Cobalt.dc.html`) found every overlay
 * `MainOverlayDialog.vue` mounts still drawing Ledger's flat panel and 10px ink title-band edge
 * regardless of aesthetic, since `.main-overlay`'s stylesheet never branched on it -- the mockups
 * draw a plain 12px-radius, clipped panel with no title-band edge at all (DESIGN-DECISIONS.md's
 * "Themes": "Dialogs and overlays ... take a 12px radius with `overflow:hidden` ... No dark eyebrow
 * bar on dialog tops").
 *
 * Sizing was the other half of this overlay's own acceptance criteria (confirm File Manager and
 * Page History stay near-full-bleed rather than picking up the Inbox/Profile centred treatment) --
 * already correct with no code change needed, since `MainOverlayDialog.vue`'s `isHalfSized` only
 * ever names `Profile`/`Inbox`.
 *
 * `.main-overlay` is a plain (non-scoped) global style block, mounted through every overlay
 * `MainOverlayDialog.vue` hosts rather than owned by any one of them -- a computed-style assertion
 * would need a full app mount plus `tailwind.css`'s real `--radius-dialog` custom property, which
 * (per `css/cobaltTokens.test.js`'s own note) is not loaded in this test environment. Checked
 * against the component's own source text instead, the same technique that suite uses for a
 * hand-edited stylesheet.
 *
 * OpenProject #2864 replaced the panel's own `overflow: hidden` clip (this test's original
 * assertion) with a transparent, non-clipping panel plus a header/body that round and fill
 * themselves -- see `MainLayout.cobaltDialogCorners.test.js` for that fix's own coverage. This
 * describe keeps only what #2776 is still actually responsible for: the eyebrow bar is gone and the
 * panel still carries the dialog radius (for its box-shadow) under Cobalt.
 */
/**
 * OpenProject #2861: the reader sidebar's `.sidebar-actions` strip gains a third cell, "Top", beside
 * Locale and Browse -- always reserving 40x40 so the other two never shift width, fading in (button
 * + leading separator) once `.page-container-scrl` scrolls past 150px, and scrolling that column
 * back to the top on click. Visual polish (the Ledger plate/mono-label + Cobalt tile treatment) is a
 * separate WP (#2862); this suite covers only the structural cell + scroll/click behavior.
 */
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

  // -> Scoped to `.sidebar-actions` for clarity/consistency with the rest of this suite, even though
  //    OpenProject #2894 retired the corner `WPageScroller` button this used to need disambiguating
  //    against -- the sidebar's own "Top" button is now the only "Return to top" control anywhere in
  //    this layout.
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

    // -> Simulates the new route's own scroll column starting back at the top
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
 * OpenProject #2862 ("Sidebar strip: Ledger + Cobalt visual treatment"): the theme-specific finish
 * on top of #2861's structural strip -- Ledger's white Top plate + mono "TOP" label + hairline cell
 * separators, Cobalt's ruleless flat tiles. Literal, class-toggleable rules (no `var()` resolution
 * needed) are asserted live via `getComputedStyle`; rules that resolve a `tailwind.css` custom
 * property are asserted against the compiled stylesheet's own source text instead, since this
 * harness never loads `tailwind.css`'s token layer and so cannot resolve `var(--color-*)`
 * reliably -- the same limitation `NavEditMenu.test.js`'s Cobalt Save-button test documents.
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

    // -> The Top button/cell only mounts once `.page-container-scrl` has scrolled past 150px (see
    //    the #2861 suite above) -- every test here needs it visible, so this helper scrolls it in
    //    unconditionally rather than repeating the fade threshold dance per test.
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
    // -> `letter-spacing: 0.18em` on the same rule as this `font-size` override: happy-dom resolves
    //    it against the element's PRIOR (inherited, 10px) font-size rather than the 7.5px this same
    //    rule sets, so the live computed value (1.8px) is an artifact of this harness's own `em`
    //    handling, not of the stylesheet -- checked against the source text instead.
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

  it('sizes the Top tile to 32x32 with no padding under Cobalt', async () => {
    const { wrapper } = await mountStrip({ cobalt: true })

    const style = getComputedStyle(wrapper.get('.sidebar-actions-top .w-btn').element)
    expect(style.width).toBe('32px')
    expect(style.height).toBe('32px')
    expect(style.padding).toBe('0px')
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

describe('MainLayout overlay chrome Cobalt aesthetic conformance (OpenProject #2776)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'MainLayout.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))

  it('drops the Ledger eyebrow bar and keeps the dialog radius on every overlay panel under Cobalt', () => {
    expect(styleBlock).toMatch(
      /@at-root \.body--cobalt & \{\s*border-top: 0;\s*border-radius: var\(--radius-dialog\);\s*background: transparent;\s*overflow: visible;\s*\}/
    )
  })
})

/**
 * OpenProject #2863 ("Retire WPageScroller corner disc in wide mode (>=1200px)") retired the corner
 * scroll-to-top button at >=1200px, where the sidebar strip's own "Top" cell (Feature #2840's
 * sibling task #2861) took over the scroll-to-top role instead. OpenProject #2894 finishes that
 * retirement: the corner disc was still mounting for the 750-1199px band, where the sidebar overlays
 * the page rather than columning beside it -- `WPageScroller.vue` is now deleted outright, and the
 * sidebar's "Top" cell (already unconditional on viewport width -- see the OpenProject #2861 suite
 * above) is the only back-to-top control anywhere in this layout, at every width. Below 750px the
 * page view's own TOC-panel opener still keeps that corner instead (`showTocPanelBtn` in
 * `pages/Index.vue`, unchanged by this task).
 *
 * `useMinWidth`'s shared `matchMedia` cache (`composables/screen.js`) is set directly on the refs it
 * returns rather than through a fresh `matchMedia` mock -- see `HeaderNav.test.js`'s own note on why
 * a NEW mock can't reach a breakpoint another test in this file already cached.
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

      // -> `.corner-btn--right` is the class the retired `WPageScroller` mount carried; the sidebar's
      //    own "Top" button (which shares the same `returnToTop` aria-label, hence not asserted on
      //    here) never carries it, so this alone is what proves the corner disc is really gone.
      expect(wrapper.find('.corner-btn--right').exists()).toBe(false)
    }
  )
})

/**
 * OpenProject #2904/#2928: the narrow-viewport sidebar opener moved from a floating bottom-left
 * corner disc (`corner-btn--left`, `tabler:menu-2`) into `HeaderNav`'s own bar, as an inline toggle
 * ahead of the logo. This layout still owns WHEN it shows (`showSidebarBtn`, unchanged) and what a
 * click does (`openSidebar()`), and hands both to the header as a prop and an emit -- so with
 * `HeaderNav` stubbed, the prop it receives and the drawer's reaction to its emit are the contract.
 *
 * Same direct-on-the-ref `useMinWidth` handling as the OpenProject #2894 suite above, for the same
 * module-level `matchMedia` cache reason.
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

  it("opens the overlaying sidebar through the header's openSidebar emit, and stands the toggle down while it is open", async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')
    const drawer = wrapper.findComponent({ name: 'WDrawer' })
    expect(drawer.props('modelValue')).toBe(false)

    headerNav(wrapper).vm.$emit('openSidebar')
    await wrapper.vm.$nextTick()

    expect(drawer.props('modelValue')).toBe(true)
    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(false)

    // -> The scrim is what closes it; the toggle comes back once it has
    drawer.vm.$emit('update:modelValue', false)
    await wrapper.vm.$nextTick()

    expect(drawer.props('modelValue')).toBe(false)
    expect(headerNav(wrapper).props('showSidebarToggle')).toBe(true)
  })
})
