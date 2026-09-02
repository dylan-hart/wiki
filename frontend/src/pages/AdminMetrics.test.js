import { describe, expect, it } from 'vitest'

import AdminMetrics from './AdminMetrics.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * Covers task 594: `/metrics` was implemented for real (not descoped), which means the admin page's
 * claims about it had to change to match — the fictitious `read:metrics` permission is gone in favor
 * of the real `manage:system` global permission, and the "nothing serves this yet" banner is gone
 * because something now does.
 *
 * Messages are supplied with the real flat dotted keys, matching how `WIKI.models.locales.getStrings`
 * actually serves `backend/locales/en.json` at runtime (`fetchLocaleStrings` → `setLocaleMessage`) —
 * an empty message set would make the `i18n-t` auth card resolve nothing and never render its slots,
 * which is exactly the part this test needs to inspect.
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

    // -> The removed banner was the only element carrying this class
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

  // -> OpenProject #1929: `/admin/metrics` names a concept this fork invented (the Prometheus metrics
  //    endpoint is not an upstream Wiki.js feature), so no docs site can describe it -- the help
  //    button was deleted rather than left pointing at a page that does not exist.
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
