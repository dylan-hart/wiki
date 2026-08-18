import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import StatusLight from '@/components/StatusLight.vue'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'

/*
  `commonStore` reads `localStorage.getItem('locale')` at store-creation time (`stores/common.js`),
  same as the real app does on boot -- but happy-dom's default `about:blank` origin under Vitest
  doesn't back a working `Storage`, unlike a real browser. `AdminLayout` pulls in `commonStore`
  unconditionally, so any mount needs a stand-in.
*/
if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
}

/**
 * Regression coverage for Task 614 (Feature 394, "Admin comments management UI rebuild"): the
 * sidebar Comments link used to be permanently `disabled` and only ever rendered behind
 * `flagsStore.experimental`, alongside Analytics. Both of those gates are now gone -- the link is a
 * normal, always-visible, clickable admin nav entry, matching General/Approvals.
 */
async function mountLayout({ experimental }) {
  setActivePinia(createPinia())

  const userStore = useUserStore()
  userStore.permissions = ['access:admin', 'manage:sites']

  const flagsStore = useFlagsStore()
  flagsStore.experimental = experimental

  // -> Avoids the pre-existing `this.sites[0].id` crash in `adminStore.fetchSites()` (called from
  //    `onMounted`) when the stubbed API_CLIENT response is empty by default.
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'sites') {
      return { json: () => Promise.resolve([{ id: 'site1', title: 'Site 1' }]) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/_admin/:siteid/general', component: { template: '<div />' } }]
  })
  router.push('/_admin/site1/general')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminLayout, {
    global: { plugins: [router, i18n], components: { StatusLight } }
  })
  await flushPromises()

  return wrapper
}

function findItemByIcon(wrapper, iconName) {
  return wrapper.findAll('.w-item').find((item) => item.find(`[data-icon="${iconName}"]`).exists())
}

describe('AdminLayout sidebar nav', () => {
  it('shows the Comments link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
    // -> A non-disabled `to` item renders as a `router-link` -> `<a>`, with the real target href.
    expect(commentsItem.element.tagName).toBe('A')
  })

  it('still gates Analytics behind the experimental flag, disabled, as before', async () => {
    const hiddenWrapper = await mountLayout({ experimental: false })
    expect(findItemByIcon(hiddenWrapper, 'img:/_assets/icons/fluent-bar-chart.svg')).toBeUndefined()

    const shownWrapper = await mountLayout({ experimental: true })
    const analyticsItem = findItemByIcon(shownWrapper, 'img:/_assets/icons/fluent-bar-chart.svg')
    expect(analyticsItem).toBeDefined()
    expect(analyticsItem.attributes('aria-disabled')).toBe('true')
  })

  it('keeps the Comments link visible when the experimental flag is on too', async () => {
    const wrapper = await mountLayout({ experimental: true })

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
  })
})
