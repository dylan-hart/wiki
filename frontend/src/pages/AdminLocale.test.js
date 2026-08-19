import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLocale from './AdminLocale.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

/**
 * Coverage indicator on the 'Active Locales' w-item loop (task 696). Each row must surface
 * `lc.completeness` -- the field `GET /_api/locales` already returns via `getLocales()` -- as an
 * at-a-glance signal (a `w-linear-progress` bar plus a percentage label), not just render the raw
 * number, and must visually distinguish an under-translated locale from a well-covered one so an
 * admin can spot it without reading every row.
 */

const LOCALES = [
  { code: 'en', name: 'English', nativeName: 'English', language: 'en', completeness: 100 },
  { code: 'fr', name: 'French', nativeName: 'Français', language: 'fr', completeness: 82 },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', language: 'am', completeness: 12 }
]

async function mountPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  // -> onMounted() only calls load() when a site is already selected
  adminStore.currentSiteId = 'site-1'
  // -> `manage:sites` satisfies `useSiteAdminAccess('site:locale')`'s GLOBAL_FALLBACKS check on its
  //    own, skipping its site-scoped fetchSitePermissions() redirect-on-denial path entirely.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/_admin/:siteid/locale', component: { template: '<div />' } }]
  })
  router.push('/_admin/site-1/locale')
  await router.isReady()

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: {
          locale: {
            completeness: '{percent}% translated'
          }
        }
      }
    }
  })

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'locales') {
      return { json: () => Promise.resolve(LOCALES) }
    }
    if (String(url).startsWith('sites/')) {
      return { json: () => Promise.resolve({ locales: { primary: 'en', active: ['en'] } }) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  return mount(AdminLocale, {
    global: { plugins: [router, i18n] }
  })
}

describe('AdminLocale: per-row completeness indicator', () => {
  it('renders a progress bar and percentage label for each locale, matching its completeness', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const bars = wrapper.findAll('.locale-completeness')
    expect(bars).toHaveLength(3)

    const labels = wrapper.findAll('.locale-completeness-label').map((el) => el.text())
    expect(labels).toEqual(['100%', '82%', '12%'])

    // -> Assert the underlying w-linear-progress value directly (via its ARIA attrs), not just text
    const progressEls = wrapper.findAll('.w-linear-progress')
    expect(progressEls).toHaveLength(3)
    expect(progressEls[0].attributes('aria-valuenow')).toBe('100')
    expect(progressEls[1].attributes('aria-valuenow')).toBe('82')
    expect(progressEls[2].attributes('aria-valuenow')).toBe('12')
  })

  it('mutes the indicator for an under-translated locale, and does not for a well-covered one', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const labels = wrapper.findAll('.locale-completeness-label')
    // -> en (100%) and fr (82%) are above the low-coverage threshold
    expect(labels[0].classes()).not.toContain('text-grey')
    expect(labels[1].classes()).not.toContain('text-grey')
    // -> am (12%) is well under it, and should read as visually muted
    expect(labels[2].classes()).toContain('text-grey')
  })

  it('surfaces the completeness percentage via a title/tooltip using the new i18n caption', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const rows = wrapper.findAll('.locale-completeness')
    expect(rows[1].attributes('title')).toBe('82% translated')
  })
})
