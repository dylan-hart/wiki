import { describe, expect, it } from 'vitest'

import AdminMetrics from './AdminMetrics.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * Flat dotted keys, the shape the runtime serves: with the message missing, the `i18n-t` auth card
 * resolves nothing and never renders the slots these tests inspect.
 */
function mountPage() {
  return mountWithApp(AdminMetrics, {
    messages: {
      'admin.metrics.auth':
        'You must provide the {headerName} header with a {tokenType} token. Generate an API key for a group with the {permission} global permission and use it as the token — the same permission this admin area itself requires.',
      'admin.metrics.endpoint': 'The metrics endpoint can be scraped at {endpoint}'
    }
  }).wrapper
}

describe('AdminMetrics auth documentation', () => {
  it('advertises the real manage:system permission, not the fictitious read:metrics', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('manage:system')
    expect(wrapper.text()).not.toContain('read:metrics')

    wrapper.unmount()
  })

  it('no longer claims the endpoint is unimplemented', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // -> `.text-orange` belonged to the "unimplemented" banner alone
    expect(wrapper.find('.text-orange').exists()).toBe(false)
    expect(wrapper.text().toLowerCase()).not.toContain('not available yet')

    wrapper.unmount()
  })

  it('load() still reads and mirrors the config-only toggle state, unchanged by the scope decision', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/metrics')
    expect(wrapper.vm.state.enabled).toBe(true)

    wrapper.unmount()
  })

  // -> The Prometheus endpoint is this fork's own, so no docs site describes it and a help button
  //    would point at a page that does not exist
  it('has no help/docs button', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.html()).not.toContain('/admin/metrics')

    wrapper.unmount()
  })
})
