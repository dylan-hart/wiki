import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminSecurity from './AdminSecurity.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

/**
 * Covers task 591: the `enforceCsp` toggle and `cspDirectives` textarea added to the security admin
 * page, following the existing HSTS (toggle + conditional detail) and CORS (`corsConfig` textarea)
 * patterns already on this page.
 *
 * `BlueprintIcon` is registered here explicitly rather than through `frontend/test/setup.js`'s
 * `sharedComponents` map -- in the real app it's a global component from `boot/components.js`, not
 * part of the `w-*` shared library, so every page that uses it needs it supplied to the mount.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminSecurity, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon }
    }
  })
}

describe('AdminSecurity CSP controls', () => {
  it('hides the CSP directives textarea until enforceCsp is turned on, then shows it', async () => {
    const wrapper = mountPage()

    // -> With corsMode defaulting to 'OFF', the CORS textarea is also hidden, so no <textarea>
    //    exists anywhere on the page until enforceCsp reveals the CSP one.
    expect(wrapper.findAll('textarea')).toHaveLength(0)

    // -> Mirrors the HSTS toggle: a `<w-toggle>` is a `role="switch"` button, found by its aria-label
    const toggle = wrapper.find('button[aria-label="admin.security.enforceCsp"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')

    const textareas = wrapper.findAll('textarea')
    expect(textareas).toHaveLength(1)
    expect(textareas[0].attributes('placeholder')).toBe('admin.security.cspDirectivesPlaceholder')

    wrapper.unmount()
  })

  it('round-trips enforceCsp and cspDirectives through load() and save()', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          enforceCsp: true,
          cspDirectives: "default-src 'self'; img-src * data:",
          corsMode: 'OFF',
          corsConfig: '',
          uploadMaxFileSize: 10485760
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    // -> load() is awaited via onMounted's fire-and-forget call; flush its microtasks
    await Promise.resolve()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.config.enforceCsp).toBe(true)
    expect(wrapper.vm.state.config.cspDirectives).toBe("default-src 'self'; img-src * data:")

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    // -> The follow-up load() inside save() would otherwise reuse the default empty mock response
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          enforceCsp: true,
          cspDirectives: "default-src 'self'; img-src * data:"
        })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'system/security',
      expect.objectContaining({
        json: expect.objectContaining({
          enforceCsp: true,
          cspDirectives: "default-src 'self'; img-src * data:"
        })
      })
    )

    wrapper.unmount()
  })
})
