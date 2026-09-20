import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminSearch from './AdminSearch.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

function engine(overrides = {}) {
  return {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    icon: '/_assets/icons/ultraviolet-database.svg',
    vendor: 'Cardinal.js',
    website: 'https://js.wiki',
    props: {
      termHighlighting: {
        type: 'boolean',
        title: 'Term Highlighting',
        hint: 'Highlight matches.',
        default: false
      }
    },
    hasImplementation: true,
    isSelected: true,
    config: { termHighlighting: false },
    ...overrides
  }
}

function mountAdminSearch() {
  const i18n = createTestI18n()
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

    expect(wrapper.text()).toContain('Term Highlighting')

    // -> Site 2 has the other engine active while still listing `db`, so a naive "keep the selection
    //    if it is still present" check would wrongly stay on `db`.
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          engine({ key: 'db', title: 'Database', isSelected: false }),
          engine({
            key: 'other',
            title: 'Other Engine',
            isSelected: true,
            props: {
              apiKey: { type: 'string', title: 'API Key', hint: 'Secret key.', default: '' }
            },
            config: { apiKey: '' }
          })
        ])
    })

    adminStore.currentSiteId = 'site-2'
    await flushPromises()

    // -> Each load fires two GETs -- the engine list, then the parallel semantic setting, in
    //    `Promise.all`'s array order -- so the site switch's engine-list call is the third overall.
    expect(API_CLIENT.get).toHaveBeenCalledTimes(4)
    expect(API_CLIENT.get).toHaveBeenNthCalledWith(3, 'sites/site-2/search/engines')
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
      .find((b) => b.find('[data-icon="tabler:refresh"]').exists())
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
            props: {
              apiKey: { type: 'string', title: 'API Key', hint: 'Secret key.', default: '' }
            },
            config: { apiKey: 'stored-value' }
          })
        ])
    })

    const wrapper = mountAdminSearch()
    await flushPromises()

    const otherItem = wrapper.findAll('.w-item').find((i) => i.text().includes('Other Engine'))
    await otherItem.trigger('click')
    await flushPromises()

    // -> Two GETs from the single load (engine list + semantic setting); selecting an
    //    already-loaded engine adds none.
    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('API Key')
    expect(wrapper.find('input[aria-label="API Key"]').element.value).toBe('stored-value')
  })

  describe('config form (task #572)', () => {
    it('shows the empty state when the selected engine declares no props', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ props: {}, config: {} })])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      expect(wrapper.text()).toContain('admin.search.engineNoConfig')
    })

    it('renders a boolean prop as a toggle and a sensitive prop as a password input', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              props: {
                termHighlighting: { type: 'boolean', title: 'Term Highlighting', default: false },
                apiKey: { type: 'string', title: 'API Key', sensitive: true, default: '' }
              },
              config: { termHighlighting: false, apiKey: 'shh' }
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      expect(wrapper.find('[role="switch"]').exists()).toBe(true)
      const pwInput = wrapper.find('input[aria-label="API Key"]')
      expect(pwInput.attributes('type')).toBe('password')
    })

    it('renders an enum prop with enumDisplay buttons as a button group', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              props: {
                mode: {
                  type: 'string',
                  title: 'Mode',
                  enum: ['fast|Fast', 'accurate|Accurate'],
                  enumDisplay: 'buttons',
                  default: 'fast'
                }
              },
              config: { mode: 'fast' }
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      const radios = wrapper.findAll('[role="radio"]')
      expect(radios.map((r) => r.text())).toEqual(['Fast', 'Accurate'])

      await radios[1].trigger('click')
      expect(radios[1].attributes('aria-checked')).toBe('true')
    })

    it('disables a readOnly prop and excludes it from the save payload', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              props: {
                indexName: { type: 'string', title: 'Index Name', readOnly: true, default: 'wiki' },
                apiKey: { type: 'string', title: 'API Key', default: '' }
              },
              config: { indexName: 'wiki', apiKey: 'secret' }
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      const indexInput = wrapper.find('input[aria-label="Index Name"]')
      expect(indexInput.attributes('disabled')).toBeDefined()

      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([engine()]) })

      const applyBtn = wrapper
        .findAll('button')
        .find((b) => b.find('[data-icon="tabler:check"]').exists())
      await applyBtn.trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/search/engines/db', {
        json: { config: { apiKey: 'secret' } }
      })
    })

    it('hides an `if`-conditional field until its sibling value matches', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              props: {
                useProxy: { type: 'boolean', title: 'Use Proxy', default: false },
                proxyUrl: {
                  type: 'string',
                  title: 'Proxy URL',
                  default: '',
                  if: [{ key: 'useProxy', eq: true }]
                }
              },
              config: { useProxy: false, proxyUrl: '' }
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      expect(wrapper.find('[aria-label="Proxy URL"]').exists()).toBe(false)

      await wrapper.find('[role="switch"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[aria-label="Proxy URL"]').exists()).toBe(true)
    })

    it('saves the config via PUT, notifies on success and reloads the engine list', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              props: {
                termHighlighting: { type: 'boolean', title: 'Term Highlighting', default: false }
              },
              config: { termHighlighting: false }
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ config: { termHighlighting: true } })])
      })

      const applyBtn = wrapper
        .findAll('button')
        .find((b) => b.find('[data-icon="tabler:check"]').exists())
      await applyBtn.trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/search/engines/db', {
        json: { config: { termHighlighting: false } }
      })
      // -> Two loads (mount + the post-save reload), two GETs each.
      expect(API_CLIENT.get).toHaveBeenCalledTimes(4)
      expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
    })

    it('notifies saveFailed when the save request is rejected', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine()])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      API_CLIENT.put.mockImplementationOnce(() => {
        throw new Error('network')
      })

      const applyBtn = wrapper
        .findAll('button')
        .find((b) => b.find('[data-icon="tabler:check"]').exists())
      await applyBtn.trigger('click')
      await flushPromises()

      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })
  })

  /**
   * No test above mocks `API_CLIENT.patch`, so a save of an unrelated prop that wrongly patched the
   * dictionary overrides would fail there on the unmocked `.json()`.
   */
  describe('dictionary override editor (task #574)', () => {
    function applyBtnOf(wrapper) {
      return wrapper.findAll('button').find((b) => b.find('[data-icon="tabler:check"]').exists())
    }

    it('renders the editor only when the db engine is selected', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine(),
            engine({
              key: 'algolia',
              title: 'Algolia',
              props: { apiKey: { type: 'string', title: 'API Key', default: '' } },
              config: { apiKey: '' },
              isSelected: false
            })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      expect(wrapper.text()).toContain('admin.search.dictOverrides')

      const algoliaItem = wrapper.findAll('.w-item').find((i) => i.text().includes('Algolia'))
      await algoliaItem.trigger('click')
      await flushPromises()

      expect(wrapper.text()).not.toContain('admin.search.dictOverrides')
    })

    it('notifies dictOverridesInvalidJSON and never calls PUT when the JSON does not parse', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ dictOverrides: { en: 'english' } })])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      await wrapper.find('[aria-label="admin.search.dictOverrides"]').setValue('not json')
      await applyBtnOf(wrapper).trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).not.toHaveBeenCalled()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })

    it('notifies dictOverridesNotAnObject for a JSON array', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ dictOverrides: { en: 'english' } })])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      await wrapper.find('[aria-label="admin.search.dictOverrides"]').setValue('[1,2]')
      await applyBtnOf(wrapper).trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).not.toHaveBeenCalled()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })

    it('notifies dictOverridesUnknown for a dictionary not in availableDictionaries', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({ dictOverrides: {}, availableDictionaries: ['english', 'simple'] })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      await wrapper.find('[aria-label="admin.search.dictOverrides"]').setValue('{"fr": "klingon"}')
      await applyBtnOf(wrapper).trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).not.toHaveBeenCalled()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })

    it('saves a changed mapping through PUT then PATCH .../search, and reloads', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({ dictOverrides: {}, availableDictionaries: ['english', 'simple'] })
          ])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      await wrapper.find('[aria-label="admin.search.dictOverrides"]').setValue('{"en": "english"}')

      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
      API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            engine({
              dictOverrides: { en: 'english' },
              availableDictionaries: ['english', 'simple']
            })
          ])
      })

      await applyBtnOf(wrapper).trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/search/engines/db', {
        json: { config: { termHighlighting: false } }
      })
      expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/search', {
        json: { dictOverrides: { en: 'english' } }
      })
      expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
      // -> Two loads (mount + the post-save reload), two GETs each.
      expect(API_CLIENT.get).toHaveBeenCalledTimes(4)
    })

    it('does not call PATCH .../search when the editor was left untouched', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ dictOverrides: { en: 'english' } })])
      })

      const wrapper = mountAdminSearch()
      await flushPromises()

      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([engine({ dictOverrides: { en: 'english' } })])
      })

      await applyBtnOf(wrapper).trigger('click')
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalled()
      expect(API_CLIENT.patch).not.toHaveBeenCalled()
      expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
    })
  })
})

/** Semantic search runs on Postgres/pgvector whichever full-text engine the picker above selects. */
describe('semantic search setting (task #3104)', () => {
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

  function mockLoad({ enabled = false, available = false } = {}) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([engine()]) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ enabled, available }) })
  }

  function toggleOf(wrapper) {
    return wrapper.find('[aria-label="admin.search.semanticEnabled"]')
  }

  function rebuildBtnOf(wrapper) {
    return wrapper.findAll('button').find((b) => b.find('[data-icon="tabler:brain"]').exists())
  }

  function applyBtnOf(wrapper) {
    return wrapper.findAll('button').find((b) => b.find('[data-icon="mdi:check"]').exists())
  }

  it('shows the unavailable hint and disables the toggle and rebuild button when the capability is off', async () => {
    mockLoad({ enabled: false, available: false })

    const wrapper = mountAdminSearch()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.search.semanticUnavailableHint')
    expect(toggleOf(wrapper).attributes('disabled')).toBeDefined()
    expect(rebuildBtnOf(wrapper).attributes('disabled')).toBeDefined()
  })

  it('shows the enabled hint and an enabled toggle reflecting the stored setting when available', async () => {
    mockLoad({ enabled: true, available: true })

    const wrapper = mountAdminSearch()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.search.semanticEnabledHint')
    expect(toggleOf(wrapper).attributes('disabled')).toBeUndefined()
    expect(toggleOf(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('saves the toggle via PATCH .../search and notifies on success', async () => {
    mockLoad({ enabled: false, available: true })

    const wrapper = mountAdminSearch()
    await flushPromises()

    await toggleOf(wrapper).trigger('click')

    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await applyBtnOf(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/search', {
      json: { semanticEnabled: true }
    })
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('notifies semanticSaveFailed and re-fetches the current value when the save is rejected', async () => {
    mockLoad({ enabled: false, available: true })

    const wrapper = mountAdminSearch()
    await flushPromises()

    await toggleOf(wrapper).trigger('click')

    API_CLIENT.patch.mockImplementationOnce(() => {
      throw new Error('network')
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ enabled: false, available: true })
    })

    await applyBtnOf(wrapper).trigger('click')
    await flushPromises()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    expect(toggleOf(wrapper).attributes('aria-checked')).toBe('false')
  })

  it('queues a rebuild via POST .../search/rebuild-embeddings and notifies on success', async () => {
    mockLoad({ enabled: true, available: true })

    const wrapper = mountAdminSearch()
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true, id: 'job-1' }) })
    await rebuildBtnOf(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/search/rebuild-embeddings')
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('notifies rebuildEmbeddingsFailed when the rebuild request is rejected', async () => {
    mockLoad({ enabled: true, available: true })

    const wrapper = mountAdminSearch()
    await flushPromises()

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network')
    })
    await rebuildBtnOf(wrapper).trigger('click')
    await flushPromises()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
  })
})

describe('admin.search.* locale block', () => {
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const localePath = join(thisDir, '../../../backend/locales/en.json')
  const componentSource = readFileSync(join(thisDir, './AdminSearch.vue'), 'utf8')
  const locale = JSON.parse(readFileSync(localePath, 'utf8'))
  const searchKeys = Object.keys(locale).filter((key) => key.startsWith('admin.search.'))

  it('has no orphaned admin.search.* key -- every one is referenced in AdminSearch.vue', () => {
    const orphaned = searchKeys.filter((key) => !componentSource.includes(key))
    expect(orphaned).toEqual([])
  })

  it('keeps only one canonical save-success string, not both saveSuccess and configSaveSuccess', () => {
    expect(searchKeys).not.toContain('admin.search.saveSuccess')
    expect(searchKeys).toContain('admin.search.configSaveSuccess')
  })
})
