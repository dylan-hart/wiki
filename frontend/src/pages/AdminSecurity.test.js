import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminSecurity from './AdminSecurity.vue'

import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `save()` PUTs the whole `state.config`, so a field missing from the reactive default vanishes from
 * every save without anything throwing -- which is what these round-trip tests guard.
 */
function mountSecurity() {
  setActivePinia(createPinia())

  const i18n = createTestI18n()

  return mount(AdminSecurity, {
    global: {
      plugins: [i18n]
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

function mountPage() {
  return mountWithApp(AdminSecurity).wrapper
}

describe('AdminSecurity CSP controls', () => {
  it('hides the CSP directives textarea until enforceCsp is turned on, then shows it', async () => {
    const wrapper = mountPage()

    // -> `corsMode` defaults to 'OFF', hiding its textarea too, so the page has none at all yet.
    expect(wrapper.findAll('textarea')).toHaveLength(0)

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
    // -> `onMounted` calls `load()` without awaiting it; flush its microtasks by hand
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
    // -> Present, since the PUT sends the whole `state.config`; harmless because `pickFields` in
    //    `models/security.ts` drops anything outside `SECURITY_FIELDS`.
    expect(opts.json.insecureCookieRiskAt).toBe('2026-08-20T12:00:00.000Z')

    wrapper.unmount()
  })
})

/**
 * The toggle and the address field both edit the one `state.config.trustProxy` field -- `false` or a
 * `proxy-addr` address/CIDR list string -- through the component's `trustProxyEnabled`/
 * `trustProxyAddresses` computed pair, not two independent fields.
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

    // -> Every `t()` resolves to its own key literal under the test i18n, so this is a wiring check
    //    on which key the template references.
    expect(wrapper.text()).toContain('admin.security.uploadsInfo')
    expect(wrapper.text()).not.toContain('admin.security.uploadsNotEnforced')
    expect(wrapper.text()).not.toContain('admin.security.uploadsPartiallyEnforced')

    wrapper.unmount()
  })
})

describe('AdminSecurity uploadMaxFilesPerBatch control', () => {
  it('loads the value from the GET response and renders it', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        uploadMaxFileSize: 10485760,
        uploadMaxFilesPerBatch: 25
      })
    })

    const wrapper = mountSecurity()
    await flushPromises()

    const input = wrapper.find('input[aria-label="admin.security.maxFilesPerBatch"]')
    expect(input.exists()).toBe(true)
    expect(input.element.value).toBe('25')
  })

  it('defaults to 10 when the server has not yet been configured', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ uploadMaxFileSize: 10485760 })
    })

    const wrapper = mountSecurity()
    await flushPromises()

    const input = wrapper.find('input[aria-label="admin.security.maxFilesPerBatch"]')
    expect(input.element.value).toBe('10')

    wrapper.unmount()
  })

  it('PUTs an edited value to system/security on save', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        uploadMaxFileSize: 10485760,
        uploadMaxFilesPerBatch: 10
      })
    })
    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true })
    })
    // -> The follow-up load() inside save() would otherwise reuse the default empty mock response
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        uploadMaxFileSize: 10485760,
        uploadMaxFilesPerBatch: 50
      })
    })

    const wrapper = mountSecurity()
    await flushPromises()

    await wrapper.find('input[aria-label="admin.security.maxFilesPerBatch"]').setValue('50')

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'system/security',
      expect.objectContaining({
        json: expect.objectContaining({ uploadMaxFilesPerBatch: 50 })
      })
    )

    wrapper.unmount()
  })
})
