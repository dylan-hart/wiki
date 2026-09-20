import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminLocale from './AdminLocale.vue'
import { queue } from '@/composables/notify'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

const LOCALES = [
  { code: 'en', name: 'English', nativeName: 'English', language: 'en', completeness: 100 },
  { code: 'fr', name: 'French', nativeName: 'Français', language: 'fr', completeness: 82 },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', language: 'am', completeness: 12 }
]

async function mountPage({ permissions = ['manage:sites'] } = {}) {
  // -> A site must already be selected for onMounted() to load, and `manage:sites` satisfies
  //    `useSiteAdminAccess('site:locale')` on its own, skipping its redirect-on-denial path
  const router = await createTestRouter(['/_admin/:siteid/locale'], '/_admin/site-1/locale')

  stubApi(
    new Map([
      ['locales', LOCALES],
      [/^sites\//, { locales: { primary: 'en', active: ['en'] } }]
    ])
  )

  return mountWithApp(AdminLocale, {
    messages: {
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
    },
    router,
    stores: { admin: { currentSiteId: 'site-1' }, user: { permissions: permissions } }
  }).wrapper
}

describe('AdminLocale: per-row completeness indicator', () => {
  it('renders a progress bar and percentage label for each locale, matching its completeness', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const bars = wrapper.findAll('.locale-completeness')
    expect(bars).toHaveLength(3)

    const labels = wrapper.findAll('.locale-completeness-label').map((el) => el.text())
    expect(labels).toEqual(['100%', '82%', '12%'])

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
    expect(labels[0].classes()).not.toContain('text-grey')
    expect(labels[1].classes()).not.toContain('text-grey')
    expect(labels[2].classes()).toContain('text-grey')
  })

  it('surfaces the completeness percentage via a title/tooltip using the new i18n caption', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const rows = wrapper.findAll('.locale-completeness')
    expect(rows[1].attributes('title')).toBe('82% translated')
  })
})

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
