import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminApi from './AdminApi.vue'

/**
 * Covers the site caption line added to each key row (task 622): a key pinned to a site names that
 * site, and an unpinned key (`siteId: null`, instance-wide) reads "All Sites" rather than a blank
 * or broken value -- the same treatment `newKeyFullAccess` already gives a `null` scope just above
 * it in the same list item.
 */
function mountPage() {
  setActivePinia(createPinia())
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: {
          api: {
            keySite: 'Site: {site}',
            newKeySiteAllSites: 'All Sites'
          }
        }
      }
    }
  })
  return mount(AdminApi, {
    global: {
      plugins: [i18n]
    }
  })
}

describe('AdminApi key list site caption', () => {
  it('names the site a key is pinned to', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      const payloads = {
        'api-keys': [
          {
            id: 'key-1',
            name: 'Docs Key',
            keyShort: 'abcd',
            groups: [],
            scope: null,
            siteId: 'site-1',
            isRevoked: false,
            isInvalidated: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          }
        ],
        'system/api': { isEnabled: true },
        groups: [],
        sites: [{ id: 'site-1', title: 'Docs' }],
        'system/certificates': { generatedAt: null }
      }
      return { json: () => Promise.resolve(payloads[resource]) }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const captions = wrapper.findAll('.w-item-label--caption').map((c) => c.text())
    expect(captions.some((c) => c.includes('Docs'))).toBe(true)
  })

  it('shows "All Sites" for an instance-wide key (siteId: null)', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      const payloads = {
        'api-keys': [
          {
            id: 'key-1',
            name: 'Global Key',
            keyShort: 'abcd',
            groups: [],
            scope: null,
            siteId: null,
            isRevoked: false,
            isInvalidated: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          }
        ],
        'system/api': { isEnabled: true },
        groups: [],
        sites: [{ id: 'site-1', title: 'Docs' }],
        'system/certificates': { generatedAt: null }
      }
      return { json: () => Promise.resolve(payloads[resource]) }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.siteName({ siteId: null })).toBe('All Sites')
  })
})
