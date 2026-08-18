import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminSecurity from './AdminSecurity.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

/**
 * Regression coverage for task 636: the admin security view must round-trip the
 * `apiRateLimit*` fields (added alongside `authRateLimit*` for task 635) through the SAME
 * `/_api/system/security` GET/PUT pair the existing authentication rate-limit fields already
 * use -- no separate endpoint. `save()` PUTs the whole `state.config` object, so a field
 * missing from the reactive default would silently vanish from every save even though nothing
 * threw.
 */
function mountSecurity() {
  setActivePinia(createPinia())

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminSecurity, {
    global: {
      plugins: [i18n],
      // -> Registered globally by `boot/components.js` in the real app; not part of the
      //    `sharedComponents` map `test/setup.js` wires up, so it needs registering here.
      components: { BlueprintIcon }
    }
  })
}

describe('AdminSecurity apiRateLimit* round-trip', () => {
  it('loads apiRateLimit* fields from the GET response and renders them', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        apiRateLimitEnabled: true,
        apiRateLimitMax: 300,
        apiRateLimitWindow: '5m',
        apiRateLimitBan: '15m',
        uploadMaxFileSize: 1024
      })
    })

    const wrapper = mountSecurity()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/security')

    // -> `aria-label` lands on `WInput`'s root `<div>` via attr fallthrough, not the inner
    //    `<input>` (WInput does not set `inheritAttrs: false`), so the real form control is one
    //    level down.
    const maxInput = wrapper.find('[aria-label="admin.security.apiRateLimitMax"] input')
    expect(maxInput.exists()).toBe(true)
    expect(maxInput.element.value).toBe('300')

    const windowInput = wrapper.find('[aria-label="admin.security.apiRateLimitWindow"] input')
    expect(windowInput.element.value).toBe('5m')

    const banInput = wrapper.find('[aria-label="admin.security.apiRateLimitBan"] input')
    expect(banInput.element.value).toBe('15m')
  })

  it('PUTs edited apiRateLimit* fields to the same system/security route on save', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        apiRateLimitEnabled: true,
        apiRateLimitMax: 300,
        apiRateLimitWindow: '5m',
        apiRateLimitBan: '15m',
        uploadMaxFileSize: 1024
      })
    })
    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true })
    })

    const wrapper = mountSecurity()
    await flushPromises()

    await wrapper.find('[aria-label="admin.security.apiRateLimitMax"] input').setValue('500')
    await wrapper.find('[aria-label="admin.security.apiRateLimitBan"] input').setValue('30m')

    const applyButton = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    expect(applyButton).toBeTruthy()
    await applyButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [url, opts] = API_CLIENT.put.mock.calls[0]
    expect(url).toBe('system/security')
    expect(opts.json).toMatchObject({
      apiRateLimitEnabled: true,
      apiRateLimitMax: 500,
      apiRateLimitWindow: '5m',
      apiRateLimitBan: '30m'
    })
  })
})
