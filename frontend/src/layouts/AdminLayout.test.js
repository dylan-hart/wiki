import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import { useUserStore } from '@/stores/user'
import { useFlagsStore } from '@/stores/flags'
import { useAdminStore } from '@/stores/admin'

/*
  `stores/common.js` reads `localStorage.getItem('locale')` at store-creation time. Node 26 (this
  repo's engine requirement) ships an experimental global `localStorage` that shadows happy-dom's own
  implementation in a way that leaves `.getItem` missing -- nothing under test actually cares about a
  persisted locale, so a minimal stub sidesteps the collision rather than fighting over which
  `localStorage` wins.
*/
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  })
})

/**
 * Regression test for the Navigation nav-tree entry's gating (Feature 358, Task 434): it used to be
 * wrapped in `flagsStore.experimental &&` and carry a `disabled` attribute, back when the screen
 * behind it (`AdminNavigation.vue`) was a dead stub. Both are gone now that the screen is real — the
 * entry should behave exactly like every other admin nav-tree item, gated on the permission check
 * alone, regardless of the experimental flag.
 */
async function mountLayout({ permissions = [], experimental = false } = {}) {
  setActivePinia(createPinia())

  const userStore = useUserStore()
  userStore.permissions = permissions

  const flagsStore = useFlagsStore()
  flagsStore.$patch({ loaded: true, experimental })

  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  router.push('/_admin/site-1/navigation')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminLayout, {
    global: {
      plugins: [router, i18n]
    }
  })
}

function findNavigationLink(wrapper) {
  return wrapper.find('a[href="/_admin/site-1/navigation"]')
}

describe('AdminLayout Navigation nav-tree entry', () => {
  it('shows the entry, not disabled, when the user has manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:navigation'], experimental: false })

    const link = findNavigationLink(wrapper)

    expect(link.exists()).toBe(true)
    expect(link.attributes('aria-disabled')).toBeUndefined()
  })

  it('shows the entry when the user has manage:sites, with the experimental flag off', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:sites'], experimental: false })

    expect(findNavigationLink(wrapper).exists()).toBe(true)
  })

  it('hides the entry when the user has neither manage:sites nor manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: [], experimental: true })

    expect(findNavigationLink(wrapper).exists()).toBe(false)
  })
})
