import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminAnalytics from './AdminAnalytics.vue'
import { useAdminStore } from '@/stores/admin'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Coverage for Task 597: the rebuilt page fetches `GET /_api/analytics/modules` (the disk-discovered
 * provider definitions) and the site's own `GET /_api/sites/:id` (which carries whatever is already
 * stored under `analytics.providers`), merges the two the same way AdminAuth.vue's
 * `buildConfigEditor(mod.props, values)` does, and PUTs the whole `analytics.providers` object back on
 * Apply. `google` here stands in for a provider that already has stored config; `matomo` stands in for
 * one that has never been configured, so its module defaults must appear in both the rendered form and
 * the saved payload.
 */
const MODULES = [
  {
    key: 'google',
    title: 'Google Analytics',
    description: 'Tracks website traffic.',
    logo: 'https://static.requarks.io/logo/google-analytics.svg',
    website: 'https://analytics.google.com/',
    isAvailable: true,
    props: {
      propertyTrackingId: {
        default: '',
        type: 'string',
        title: 'Property Tracking ID',
        hint: 'G-XXXXXXXXXX',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 1,
        if: []
      }
    }
  },
  {
    key: 'matomo',
    title: 'Matomo',
    description: 'Privacy-friendly analytics.',
    logo: 'https://static.requarks.io/logo/matomo.svg',
    website: 'https://matomo.org/',
    isAvailable: true,
    props: {
      siteId: {
        default: '1',
        type: 'string',
        title: 'Site ID',
        hint: '',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 1,
        if: []
      },
      serverHost: {
        default: 'https://example.matomo.cloud',
        type: 'string',
        title: 'Server Host',
        hint: '',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 2,
        if: []
      }
    }
  }
]

const SITE = {
  id: 'site-1',
  analytics: {
    providers: {
      google: { isEnabled: true, config: { propertyTrackingId: 'G-EXISTING' } }
    }
  }
}

async function mountLoaded() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = SITE.id

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(MODULES) })
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(SITE) })

  const i18n = createTestI18n()
  const wrapper = mount(AdminAnalytics, { global: { plugins: [i18n] } })
  await flushPromises()

  return wrapper
}

describe('AdminAnalytics provider load/save round-trip', () => {
  it('PUTs the full analytics.providers object, defaulting a provider with no stored config', async () => {
    const wrapper = await mountLoaded()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const applyBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    await applyBtn.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [url, options] = API_CLIENT.put.mock.calls[0]
    expect(url).toBe(`sites/${SITE.id}`)
    expect(options.json).toEqual({
      analytics: {
        providers: {
          google: { isEnabled: true, config: { propertyTrackingId: 'G-EXISTING' } },
          matomo: {
            isEnabled: false,
            config: { siteId: '1', serverHost: 'https://example.matomo.cloud' }
          }
        }
      }
    })
  })

  it('saves an edited enabled flag and config value for the selected provider', async () => {
    const wrapper = await mountLoaded()

    // -> google is the first module, so it is selected by default
    const enabledToggle = wrapper.find('[aria-label="admin.analytics.enabled"]')
    expect(enabledToggle.exists()).toBe(true)
    await enabledToggle.trigger('click')

    const trackingInput = wrapper.find('input[aria-label="Property Tracking ID"]')
    expect(trackingInput.exists()).toBe(true)
    await trackingInput.setValue('G-NEW-VALUE')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    const applyBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    await applyBtn.trigger('click')
    await flushPromises()

    const [, options] = API_CLIENT.put.mock.calls[0]
    expect(options.json.analytics.providers.google).toEqual({
      isEnabled: false,
      config: { propertyTrackingId: 'G-NEW-VALUE' }
    })
  })
})
