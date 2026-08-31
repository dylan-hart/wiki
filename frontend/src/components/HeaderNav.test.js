import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import HeaderNav from './HeaderNav.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

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

async function mountHeaderNav() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

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

  return { wrapper, siteStore, userStore }
}

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
 * OpenProject #2074: "Create New Page" used to draw `la:plus-circle` while every equivalent
 * create-affordance elsewhere (Index.vue, WelcomeOverlay.vue, AdminSites.vue, ...) draws `la:plus`
 * for the same kind of action -- settled on `la:plus` everywhere, so this button must not regress
 * back to the other glyph.
 */
describe('HeaderNav "Create New Page" icon (OpenProject #2074)', () => {
  it('uses the settled la:plus add glyph, not la:plus-circle', async () => {
    const { wrapper, userStore } = await mountHeaderNav()
    userStore.permissions = ['write:pages']
    await wrapper.vm.$nextTick()

    const createButton = wrapper.find('[aria-label="Create New Page"]')
    expect(createButton.exists()).toBe(true)
    expect(createButton.find('[data-icon="la:plus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="la:plus-circle"]').exists()).toBe(false)
  })
})
