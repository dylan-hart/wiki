import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminLocale from './AdminLocale.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

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

async function mountPage({ permissions = ['manage:sites'] } = {}) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  // -> onMounted() only calls load() when a site is already selected
  adminStore.currentSiteId = 'site-1'
  // -> `manage:sites` satisfies `useSiteAdminAccess('site:locale')`'s GLOBAL_FALLBACKS check on its
  //    own, skipping its site-scoped fetchSitePermissions() redirect-on-denial path entirely.
  const userStore = useUserStore()
  userStore.permissions = permissions

  const router = await createTestRouter(['/_admin/:siteid/locale'], '/_admin/site-1/locale')

  const i18n = createTestI18n({
    admin: {
      locale: {
        completeness: '{percent}% translated',
        sideload: 'Sideload Locale Package',
        sideloadHelp: 'sideload help text',
        sideloadSuccess: '{count} locale package(s) loaded successfully.',
        sideloadNone: 'No locale packages were found to sideload.',
        sideloadFailed: 'Failed to sideload locale packages.'
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

/**
 * OpenProject #1886: `POST /_api/locales/sideload` (backend/api/locales.ts) already exists and is
 * `manage:system`-gated, but nothing in the UI called it -- `grep -rn 'sideload' frontend/src`
 * returned nothing before this. The route takes no body: it rescans `<dataPath>/locales/` on the
 * server's own data volume for locale-pack JSON files an operator placed there out-of-band, so the
 * control is a "sideload now" trigger, not a file picker.
 */
describe('AdminLocale: offline sideload control', () => {
  function sideloadButton(wrapper) {
    return wrapper.findAll('button').find((b) => b.text().includes('Sideload Locale Package'))
  }

  beforeEach(() => {
    queue.splice(0, queue.length)
  })

  it('is hidden for an admin without manage:system, even with site:locale access', async () => {
    const wrapper = await mountPage({ permissions: ['manage:sites'] })
    await flushPromises()

    expect(sideloadButton(wrapper)).toBeUndefined()
  })

  it('renders the sideload control and help text for a manage:system admin', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    expect(sideloadButton(wrapper)).toBeDefined()
    expect(wrapper.text()).toContain('sideload help text')
  })

  it('posts to locales/sideload and renders a success state, then refreshes the locale list', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()
    API_CLIENT.get.mockClear()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ loaded: ['tlh'], skipped: [] })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('locales/sideload')
    expect(queue.at(-1)).toMatchObject({
      type: 'positive',
      message: '1 locale package(s) loaded successfully.',
      caption: 'tlh'
    })
    // -> A newly-loaded locale should show up without a manual page refresh
    expect(API_CLIENT.get).toHaveBeenCalledWith('locales')
  })

  it('renders a failure state when the request rejects, without refreshing the list', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()
    API_CLIENT.get.mockClear()

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network error')
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to sideload locale packages.',
      caption: 'network error'
    })
    expect(API_CLIENT.get).not.toHaveBeenCalledWith('locales')
  })

  it('renders a failure state for skipped files even when the request itself succeeds', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ loaded: [], skipped: [{ code: 'broken', error: 'invalid JSON' }] })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to sideload locale packages.',
      caption: 'broken: invalid JSON'
    })
  })

  it('reports when nothing was found to sideload', async () => {
    const wrapper = await mountPage({ permissions: ['manage:system'] })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ loaded: [], skipped: [] })
    })

    await sideloadButton(wrapper).trigger('click')
    await flushPromises()

    expect(queue.at(-1)).toMatchObject({
      type: 'info',
      message: 'No locale packages were found to sideload.'
    })
  })
})
