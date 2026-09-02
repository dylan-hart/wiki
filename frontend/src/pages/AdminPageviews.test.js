import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminPageviews from './AdminPageviews.vue'
import { useAdminStore } from '@/stores/admin'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Covers OpenProject #1238's admin opt-out UI: `AdminPageviews.vue` is the `manage:system`-gated
 * on/off toggle for pageview tracking, wired to `GET`/`PUT system/pageviews` the same way
 * `AdminMetrics.vue`/`AdminApi.vue` wire their own toggles (see those files' own tests for the
 * pattern this mirrors).
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createTestI18n()

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

  /**
   * OpenProject #2335: the page used to be a bare toggle with no evidence tracking was actually
   * recording anything. These cover the added `summary` block -- populated from the response, and
   * rendered as real evidence rather than staying invisible.
   */
  it('load() populates state.summary from the response', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          isEnabled: true,
          summary: {
            totalViews: 42,
            last24h: 3,
            last7d: 10,
            distinctPages: 7,
            mostRecentAt: '2026-08-31T00:00:00.000Z'
          }
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.summary).toEqual({
      totalViews: 42,
      last24h: 3,
      last7d: 10,
      distinctPages: 7,
      mostRecentAt: '2026-08-31T00:00:00.000Z'
    })
    expect(wrapper.text()).toContain('42')
    expect(wrapper.find('.pageviews-stat').exists()).toBe(true)

    wrapper.unmount()
  })

  it('shows the empty state instead of stat tiles when no views have ever been recorded', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          isEnabled: true,
          summary: { totalViews: 0, last24h: 0, last7d: 0, distinctPages: 0, mostRecentAt: null }
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.pageviews-stat').exists()).toBe(false)

    wrapper.unmount()
  })

  it('load() falls back to a zeroed summary when the response has none', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.summary).toEqual({
      totalViews: 0,
      last24h: 0,
      last7d: 0,
      distinctPages: 0,
      mostRecentAt: null
    })

    wrapper.unmount()
  })
})
