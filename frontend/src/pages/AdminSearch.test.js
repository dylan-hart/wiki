import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminSearch from './AdminSearch.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * Task #571 -- `AdminSearch.vue` rebuilt around a per-site engine picker.
 *
 * Covers the three requirements the task spec calls out concretely: an engine with no
 * implementation is rendered disabled, a `currentSiteId` change reloads the list and resets the
 * selection onto the new site's active engine (rather than staying pinned to the old one), and the
 * refresh button hits the new refresh endpoint and surfaces `listRefreshSuccess`.
 */

function engine(overrides = {}) {
  return {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    icon: '/_assets/icons/ultraviolet-database.svg',
    vendor: 'Wiki.js',
    website: 'https://js.wiki',
    props: { termHighlighting: { title: 'Term Highlighting', hint: 'Highlight matches.' } },
    hasImplementation: true,
    isSelected: true,
    config: { termHighlighting: false },
    ...overrides
  }
}

function mountAdminSearch() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  return mount(AdminSearch, {
    global: {
      plugins: [i18n]
    }
  })
}

describe('AdminSearch engine picker', () => {
  let adminStore

  beforeEach(() => {
    setActivePinia(createPinia())
    adminStore = useAdminStore()
    adminStore.currentSiteId = 'site-1'
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders installed engines and greys out one with no implementation', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          engine(),
          engine({
            key: 'algolia',
            title: 'Algolia',
            isSelected: false,
            hasImplementation: false,
            props: {},
            config: {}
          })
        ])
    })

    const wrapper = mountAdminSearch()
    await flushPromises()

    const items = wrapper.findAll('.w-item')
    const dbItem = items.find((i) => i.text().includes('Database'))
    const algoliaItem = items.find((i) => i.text().includes('Algolia'))

    expect(dbItem.attributes('aria-disabled')).toBeUndefined()
    expect(algoliaItem.attributes('aria-disabled')).toBe('true')
  })

  it('reloads the engine list and resets the selection when the current site changes', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          engine({ key: 'db', title: 'Database', isSelected: true }),
          engine({ key: 'other', title: 'Other Engine', isSelected: false })
        ])
    })

    const wrapper = mountAdminSearch()
    await flushPromises()

    // -> Site 1's active engine (`db`) is what the config panel opens on
    expect(wrapper.text()).toContain('Term Highlighting')

    // -> Site 2 has the OTHER engine active, and shares the `db` key -- a naive "keep selection if
    //    still present" check would wrongly stay on `db` here, since it still exists in this list too
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          engine({ key: 'db', title: 'Database', isSelected: false }),
          engine({
            key: 'other',
            title: 'Other Engine',
            isSelected: true,
            props: { apiKey: { title: 'API Key', hint: 'Secret key.' } },
            config: { apiKey: '' }
          })
        ])
    })

    adminStore.currentSiteId = 'site-2'
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-2/search/engines')
    expect(wrapper.text()).toContain('API Key')
    expect(wrapper.text()).not.toContain('Term Highlighting')
  })

  it('wires the refresh button to the refresh endpoint and notifies on success', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([engine()])
    })

    const wrapper = mountAdminSearch()
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve([engine(), engine({ key: 'new-engine', title: 'New Engine' })])
    })

    const refreshBtn = wrapper
      .findAll('button')
      .find((b) => b.find('[data-icon="la:redo-alt"]').exists())
    await refreshBtn.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/search/refresh')
    expect(wrapper.text()).toContain('New Engine')
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('selects an engine from the already-loaded list with no extra round trip', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          engine({ key: 'db', title: 'Database', isSelected: true }),
          engine({
            key: 'other',
            title: 'Other Engine',
            isSelected: false,
            props: { apiKey: { title: 'API Key', hint: 'Secret key.' } },
            config: { apiKey: 'stored-value' }
          })
        ])
    })

    const wrapper = mountAdminSearch()
    await flushPromises()

    const otherItem = wrapper.findAll('.w-item').find((i) => i.text().includes('Other Engine'))
    await otherItem.trigger('click')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('API Key')
    expect(wrapper.text()).toContain('stored-value')
  })
})
