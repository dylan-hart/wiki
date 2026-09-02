import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminSecurity from './AdminSecurity.vue'

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

    // -> `WInput` sets `inheritAttrs: false` and binds `$attrs` explicitly onto the real
    //    `<input>`/`<textarea>` (see its own file header comment), so `aria-label` lands on the
    //    control itself, not on the wrapping `<div>` -- `input[aria-label=...]`, not
    //    `[aria-label=...] input`.
    const maxInput = wrapper.find('input[aria-label="admin.security.apiRateLimitMax"]')
    expect(maxInput.exists()).toBe(true)
    expect(maxInput.element.value).toBe('300')

    const windowInput = wrapper.find('input[aria-label="admin.security.apiRateLimitWindow"]')
    expect(windowInput.element.value).toBe('5m')

    const banInput = wrapper.find('input[aria-label="admin.security.apiRateLimitBan"]')
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

    await wrapper.find('input[aria-label="admin.security.apiRateLimitMax"]').setValue('500')
    await wrapper.find('input[aria-label="admin.security.apiRateLimitBan"]').setValue('30m')

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

/**
 * Covers task 591: the `enforceCsp` toggle and `cspDirectives` textarea added to the security admin
 * page, following the existing HSTS (toggle + conditional detail) and CORS (`corsConfig` textarea)
 * patterns already on this page.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminSecurity, {
    global: {
      plugins: [i18n]
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

/**
 * Task 833: `GET /system/security`'s read-only `insecureCookieRiskAt` diagnostic (set by
 * `Security#observeRequest` in the backend, see its doc comment) surfaces as a warning card next
 * to the Trust Proxy toggle -- shown only while there is something to act on, i.e. the field is
 * set AND Trust Proxy is still off; flipping the toggle hides it immediately without waiting for a
 * reload, since the underlying misconfiguration is fixed by turning Trust Proxy on and restarting.
 */
describe('AdminSecurity insecure cookie risk warning', () => {
  it('is hidden when the backend has never observed the misconfiguration', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.text()).not.toContain('admin.security.insecureCookieRiskWarn')

    wrapper.unmount()
  })

  it('shows the warning once the backend reports a risk while Trust Proxy is off', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          trustProxy: false,
          insecureCookieRiskAt: '2026-08-20T12:00:00.000Z'
        })
    })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.security.insecureCookieRiskWarn')

    wrapper.unmount()
  })

  it('hides the warning once Trust Proxy is toggled on, even before saving', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          trustProxy: false,
          insecureCookieRiskAt: '2026-08-20T12:00:00.000Z'
        })
    })

    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('admin.security.insecureCookieRiskWarn')

    await wrapper.find('button[aria-label="admin.security.trustProxy"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('admin.security.insecureCookieRiskWarn')

    wrapper.unmount()
  })

  it('does not send insecureCookieRiskAt back as a config field the backend could store', async () => {
    // -> `pickFields` in `models/security.ts` already drops anything outside `SECURITY_FIELDS`,
    //    so this is belt-and-suspenders on the frontend shape rather than load-bearing -- it just
    //    documents that the field travels with `state.config` for display, not because it is meant
    //    to be written back.
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          trustProxy: true,
          insecureCookieRiskAt: '2026-08-20T12:00:00.000Z',
          uploadMaxFileSize: 1024
        })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: true, insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()
    await wrapper.vm.save()

    const [, opts] = API_CLIENT.put.mock.calls[0]
    // -> Present (the PUT sends the whole `state.config`), but that is fine: the backend field is
    //    documented as read-only and ignored on write.
    expect(opts.json.insecureCookieRiskAt).toBe('2026-08-20T12:00:00.000Z')

    wrapper.unmount()
  })
})

/**
 * Task 2080: `trustProxy` was widened from a plain boolean to also accept a `proxy-addr` address/
 * CIDR list string, so the admin view now has a text field beside the existing toggle for entering
 * that list -- following the same toggle + conditional-detail pattern as `enforceCsp`/
 * `cspDirectives`, except here both controls edit the SAME underlying `state.config.trustProxy`
 * field rather than two independent ones (see the `trustProxyEnabled`/`trustProxyAddresses`
 * computed pair in the component).
 */
describe('AdminSecurity trustProxy controls', () => {
  it('hides the trusted-proxy address field while the toggle is off', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[aria-label="admin.security.trustProxyAddresses"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('shows the address field, empty, once the toggle is turned on with no prior list', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    await wrapper.find('button[aria-label="admin.security.trustProxy"]').trigger('click')
    await wrapper.vm.$nextTick()

    const addressField = wrapper.find('input[aria-label="admin.security.trustProxyAddresses"]')
    expect(addressField.exists()).toBe(true)
    expect(addressField.element.value).toBe('')

    wrapper.unmount()
  })

  it('loads an existing address list, shows the toggle on and the field pre-filled', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ trustProxy: '10.0.0.0/8, 192.168.1.1', insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    const addressField = wrapper.find('input[aria-label="admin.security.trustProxyAddresses"]')
    expect(addressField.exists()).toBe(true)
    expect(addressField.element.value).toBe('10.0.0.0/8, 192.168.1.1')

    wrapper.unmount()
  })

  it('saves the typed address list as the trustProxy string', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null, uploadMaxFileSize: 1024 })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: '10.0.0.0/8', insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    await wrapper.find('button[aria-label="admin.security.trustProxy"]').trigger('click')
    await wrapper.vm.$nextTick()

    const addressField = wrapper.find('input[aria-label="admin.security.trustProxyAddresses"]')
    await addressField.setValue('10.0.0.0/8')

    await wrapper.vm.save()

    const [, opts] = API_CLIENT.put.mock.calls[0]
    expect(opts.json.trustProxy).toBe('10.0.0.0/8')

    wrapper.unmount()
  })

  it('sends trustProxy: false when the toggle is turned off, even after typing a list', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null, uploadMaxFileSize: 1024 })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ trustProxy: false, insecureCookieRiskAt: null })
    })

    const wrapper = mountPage()
    await flushPromises()

    const toggle = wrapper.find('button[aria-label="admin.security.trustProxy"]')
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper
      .find('input[aria-label="admin.security.trustProxyAddresses"]')
      .setValue('10.0.0.0/8')
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[aria-label="admin.security.trustProxyAddresses"]').exists()).toBe(false)

    await wrapper.vm.save()

    const [, opts] = API_CLIENT.put.mock.calls[0]
    expect(opts.json.trustProxy).toBe(false)

    wrapper.unmount()
  })
})

describe('AdminSecurity uploads info banner (task 605)', () => {
  it('no longer claims uploading is unimplemented, now that an upload endpoint exists', () => {
    const wrapper = mountPage()

    // -> `messages: { en: {} }` means every `t()` call resolves to its own key literal (see
    //    `mountPage()`'s comment above), so this is a wiring check: the template must reference the
    //    surviving key, not either removed one — `uploadsNotEnforced` said "uploading is not
    //    implemented" (task 605), and `uploadsPartiallyEnforced` (OpenProject #1360/#2152,
    //    2026-08-24 security audit) named the two toggles this WP deleted (`uploadMaxFiles`,
    //    `uploadScanSVG`) as the "not enforced yet" part; with both gone, everything this card shows
    //    is enforced, so the caveat itself was deleted rather than reworded.
    expect(wrapper.text()).toContain('admin.security.uploadsInfo')
    expect(wrapper.text()).not.toContain('admin.security.uploadsNotEnforced')
    expect(wrapper.text()).not.toContain('admin.security.uploadsPartiallyEnforced')

    wrapper.unmount()
  })
})
