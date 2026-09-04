import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MainLayout from './MainLayout.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

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
