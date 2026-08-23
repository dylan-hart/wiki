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
 * OpenProject #1120 (2.5.x parity, epic #987): the only way into `/_tags` was clicking an existing
 * tag chip on an already-tagged page -- nothing in the header pointed there for a reader who isn't
 * on one yet. `common.header.browseTags` already existed in the locale file, unused, which is what
 * this reinstates.
 */
describe('HeaderNav "Browse by tags" entry point (OpenProject #1120)', () => {
  it('renders a link to /_tags beside the other header action buttons', async () => {
    const { wrapper } = await mountHeaderNav()

    const tagsLink = wrapper.findAll('a').find((a) => a.attributes('href') === '/_tags')
    expect(tagsLink).toBeTruthy()
  })

  it('shows unconditionally -- unlike the graph button, it is gated on no feature flag', async () => {
    const { wrapper, siteStore } = await mountHeaderNav()
    siteStore.features.browse = false
    await wrapper.vm.$nextTick()

    const tagsLink = wrapper.findAll('a').find((a) => a.attributes('href') === '/_tags')
    expect(tagsLink).toBeTruthy()
  })
})
