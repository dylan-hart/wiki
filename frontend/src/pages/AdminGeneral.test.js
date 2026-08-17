import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminGeneral from './AdminGeneral.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Regression coverage for Task 588: `defaultConfig()` used to seed a `defaults.timezone` /
 * `dateFormat` / `timeFormat` sub-object that rendered no control in the template, was dropped by
 * `save()` before it ever reached the API, and had no backend counterpart (per-user timezone/date/time
 * preferences live in `ProfileInfo.vue` instead). Removing that dead scaffolding must not change what
 * `save()` actually sends — this mounts the real page, loads a fixture site through it, and asserts
 * the `PUT /_api/sites/:id` body still carries every field the admin UI is responsible for, unchanged.
 */
const FIXTURE_SITE = {
  id: 'site-1',
  hostname: 'wiki.example.com',
  title: 'My Wiki',
  description: 'A description',
  company: 'Acme Corp',
  contentLicense: 'ccby',
  footerExtra: 'footer text',
  pageExtensions: ['md', 'html'],
  logoText: true,
  discoverable: true,
  sitemap: true,
  robots: { index: true, follow: false },
  uploads: { conflictBehavior: 'reject' },
  features: {
    browse: true,
    comments: true,
    ratingsMode: 'stars',
    profile: true,
    reasonForChange: 'optional',
    search: true
  },
  defaults: { tocDepth: { min: 2, max: 4 } },
  assets: { logo: false, favicon: false }
}

async function mountLoaded() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = FIXTURE_SITE.id

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_SITE) })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const wrapper = mount(AdminGeneral, { global: { plugins: [i18n] } })
  await flushPromises()

  return wrapper
}

describe('AdminGeneral save() field round-trip', () => {
  it('sends every field load() populated, and never re-introduces defaults.timezone/dateFormat/timeFormat', async () => {
    const wrapper = await mountLoaded()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([FIXTURE_SITE]) })

    const applyBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    await applyBtn.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [url, options] = API_CLIENT.put.mock.calls[0]
    expect(url).toBe(`sites/${FIXTURE_SITE.id}`)

    expect(options.json).toEqual({
      hostname: FIXTURE_SITE.hostname,
      title: FIXTURE_SITE.title,
      description: FIXTURE_SITE.description,
      company: FIXTURE_SITE.company,
      contentLicense: FIXTURE_SITE.contentLicense,
      footerExtra: FIXTURE_SITE.footerExtra,
      pageExtensions: FIXTURE_SITE.pageExtensions,
      logoText: FIXTURE_SITE.logoText,
      sitemap: FIXTURE_SITE.sitemap,
      uploads: { conflictBehavior: 'reject' },
      robots: { index: true, follow: false },
      features: {
        browse: true,
        comments: true,
        ratingsMode: 'stars',
        profile: true,
        reasonForChange: 'optional',
        search: true
      },
      discoverable: true,
      defaults: { tocDepth: { min: 2, max: 4 } }
    })
  })
})
