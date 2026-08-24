import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminPageviews from './AdminPageviews.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Covers OpenProject #1238's admin opt-out UI: `AdminPageviews.vue` is the `manage:system`-gated
 * on/off toggle for pageview tracking, wired to `GET`/`PUT system/pageviews` the same way
 * `AdminMetrics.vue`/`AdminApi.vue` wire their own toggles (see those files' own tests for the
 * pattern this mirrors).
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminPageviews, {
    global: {
      plugins: [i18n]
    }
  })
}

describe('AdminPageviews', () => {
  it('load() reads system/pageviews and mirrors the toggle state', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/pageviews')
    expect(wrapper.vm.state.enabled).toBe(true)

    wrapper.unmount()
  })

  it('load() keeps the admin store sidebar light in step', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: false }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    const adminStore = useAdminStore()
    expect(adminStore.info.isPageviewsEnabled).toBe(false)

    wrapper.unmount()
  })

  it('globalSwitch() PUTs the flipped state and reloads', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: false }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.state.enabled).toBe(false)

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isEnabled: true })
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    await wrapper.vm.globalSwitch()

    expect(API_CLIENT.put).toHaveBeenCalledWith('system/pageviews', { json: { isEnabled: true } })
    expect(wrapper.vm.state.enabled).toBe(true)

    wrapper.unmount()
  })
})
