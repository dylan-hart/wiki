import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Search from './Search.vue'
import { queue as notifications } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  vi.useFakeTimers()
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  notifications.splice(0)
  vi.useRealTimers()
  vi.clearAllMocks()
})

const HIT = {
  id: 'p1',
  path: 'some/page',
  locale: 'en',
  title: 'Some Page',
  description: null,
  icon: null,
  tags: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: null
}

function createI18n() {
  return createTestI18n({
    search: {
      results: 'Search Results',
      emptyQuery: 'Enter a query.',
      totalResults: 'No result | {0} result | {0} results',
      totalResultsApprox: 'No result | At least {0} result | At least {0} results',
      loadMore: 'Load More',
      modeKeyword: 'Keyword',
      modeSemantic: 'Semantic',
      addFilter: 'Add filter',
      removeFilter: 'Remove filter',
      filtersActive: 'Filters ({count})',
      filterModeInclude: 'Include',
      filterModeExclude: 'Exclude',
      filterTypePath: 'Path',
      filterTypeTag: 'Tag',
      filterTypeLocale: 'Locale',
      filterTypeEditor: 'Editor',
      filterTypePublishState: 'Publish State',
      publishStateDraft: 'Draft',
      publishStatePublished: 'Published',
      publishStateScheduled: 'Scheduled',
      filtersSaveFailed: 'Could not save your search filters.'
    }
  })
}

async function mountSearch({
  authenticated = false,
  profile = { searchFilters: [] },
  initialPath = '/_search?q=onboarding',
  activeLocales = ['en'],
  putFails = false
} = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.locales.active = activeLocales.map((code) => ({ code, name: code.toUpperCase() }))
  useUserStore().authenticated = authenticated

  API_CLIENT.get.mockImplementation((url) => ({
    json: () =>
      url === 'users/profile'
        ? Promise.resolve(profile)
        : Promise.resolve({ results: [HIT], totalHits: 1, suggestion: null })
  }))
  API_CLIENT.put.mockImplementation(() => ({
    json: () => (putFails ? Promise.reject(new Error('nope')) : Promise.resolve({ ok: true }))
  }))

  const router = await createTestRouter(
    [{ path: '/_search', component: Search }, '/:pathMatch(.*)*'],
    initialPath
  )
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createI18n()],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await settle()
  return { wrapper }
}

async function settle(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

const rowsOf = (wrapper) => wrapper.findAll('[data-testid="search-filter-row"]')
const searchCalls = () =>
  API_CLIENT.get.mock.calls.filter(([url]) => url.startsWith('sites/site-1/pages/search'))
const lastSearchParams = () => searchCalls().at(-1)[1].searchParams
const filterParams = (pairs) =>
  pairs.filter(
    ([name]) => !['query', 'offset', 'limit', 'orderBy', 'orderByDirection'].includes(name)
  )

async function addRow(wrapper) {
  await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
}

function selectIn(row, testid) {
  return row
    .findAllComponents({ name: 'WSelect' })
    .find(
      (c) => c.attributes('data-testid') === testid || c.find(`[data-testid="${testid}"]`).exists()
    )
}

async function pick(wrapper, index, testid, value) {
  selectIn(rowsOf(wrapper)[index], testid).vm.$emit('update:modelValue', value)
  await flushPromises()
}

const valueControl = (wrapper, index) =>
  rowsOf(wrapper)[index].find('[data-testid="search-filter-value"]')

describe('Search.vue filter rows driven through the DOM (OpenProject #3521)', () => {
  describe('Include/Exclude and type switching', () => {
    it('renames the request param when a row flips between Include and Exclude', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')
      await settle()
      expect(filterParams(lastSearchParams())).toEqual([['path', 'docs']])

      await pick(wrapper, 0, 'search-filter-mode', 'exclude')
      await settle()
      expect(filterParams(lastSearchParams())).toEqual([['excludePath', 'docs']])

      await pick(wrapper, 0, 'search-filter-mode', 'include')
      await settle()
      expect(filterParams(lastSearchParams())).toEqual([['path', 'docs']])
    })

    it('shows the selected mode and type in the row controls', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      const row = rowsOf(wrapper)[0]
      expect(row.find('[data-testid="search-filter-mode"]').text()).toContain('Include')
      expect(row.find('[data-testid="search-filter-type"]').text()).toContain('Path')

      await pick(wrapper, 0, 'search-filter-mode', 'exclude')
      await pick(wrapper, 0, 'search-filter-type', 'tag')

      expect(rowsOf(wrapper)[0].find('[data-testid="search-filter-mode"]').text()).toContain(
        'Exclude'
      )
      expect(rowsOf(wrapper)[0].find('[data-testid="search-filter-type"]').text()).toContain('Tag')
    })

    it('clears typed text when a free-text row switches to a dropdown type', async () => {
      const { wrapper } = await mountSearch({ activeLocales: ['en', 'fr'] })
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')

      await pick(wrapper, 0, 'search-filter-type', 'locale')

      expect(wrapper.vm.state.filters[0]).toMatchObject({ type: 'locale', value: '' })
      expect(valueControl(wrapper, 0).attributes('role')).toBe('combobox')
    })

    it('drops a stale value from the request when the type changes underneath it', async () => {
      const { wrapper } = await mountSearch({ activeLocales: ['en', 'fr'] })
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')
      await settle()
      expect(filterParams(lastSearchParams())).toEqual([['path', 'docs']])

      await pick(wrapper, 0, 'search-filter-type', 'editor')
      await settle()

      expect(filterParams(lastSearchParams())).toEqual([])
    })

    it('resumes sending once a switched-to dropdown type has a value', async () => {
      const { wrapper } = await mountSearch({ activeLocales: ['en', 'fr'] })
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'editor')
      await pick(wrapper, 0, 'search-filter-value', 'markdown')
      await settle()

      expect(filterParams(lastSearchParams())).toEqual([['editor', 'markdown']])
    })

    it('starts a Publish State row at Published and sends it straight away', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'publishState')
      await settle()

      expect(filterParams(lastSearchParams())).toEqual([['publishState', 'published']])
    })

    it('starts a Locale row at the only active locale and sends it straight away', async () => {
      const { wrapper } = await mountSearch({ activeLocales: ['en'] })
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'locale')
      await settle()

      expect(filterParams(lastSearchParams())).toEqual([['locales', 'en']])
    })
  })

  describe('per-type value editors', () => {
    it('offers exactly the active site locales for a Locale row', async () => {
      const { wrapper } = await mountSearch({ activeLocales: ['en', 'fr', 'de'] })
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'locale')

      const options = selectIn(rowsOf(wrapper)[0], 'search-filter-value').props('options')
      expect(options.map((o) => o.value)).toEqual(['en', 'fr', 'de'])
    })

    it('offers the three editors for an Editor row', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'editor')

      const options = selectIn(rowsOf(wrapper)[0], 'search-filter-value').props('options')
      expect(options.map((o) => o.value)).toEqual(['asciidoc', 'markdown', 'wysiwyg'])
    })

    it('offers draft, published and scheduled for a Publish State row', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-type', 'publishState')

      const options = selectIn(rowsOf(wrapper)[0], 'search-filter-value').props('options')
      expect(options.map((o) => o.value)).toEqual(['draft', 'published', 'scheduled'])
    })

    it('draws a text input with a "/" prefix for Path and a "#" prefix for Tag', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      const input = () => rowsOf(wrapper)[0].find('input[data-testid="search-filter-value"]')
      expect(input().exists()).toBe(true)
      expect(rowsOf(wrapper)[0].text()).toContain('/')

      await pick(wrapper, 0, 'search-filter-type', 'tag')
      expect(input().exists()).toBe(true)
      expect(rowsOf(wrapper)[0].text()).toContain('#')
    })
  })

  describe('request params for every mode and type', () => {
    const CASES = [
      ['include', 'path', 'docs', 'path'],
      ['exclude', 'path', 'docs', 'excludePath'],
      ['include', 'tag', 'alpha', 'tags'],
      ['exclude', 'tag', 'alpha', 'excludeTags'],
      ['include', 'locale', 'fr', 'locales'],
      ['exclude', 'locale', 'fr', 'excludeLocales'],
      ['include', 'editor', 'markdown', 'editor'],
      ['exclude', 'editor', 'markdown', 'excludeEditor'],
      ['include', 'publishState', 'draft', 'publishState'],
      ['exclude', 'publishState', 'draft', 'excludePublishState']
    ]

    for (const [mode, type, value, name] of CASES) {
      it(`sends a ${mode} ${type} row as [${name}, ${value}]`, async () => {
        const { wrapper } = await mountSearch({ activeLocales: ['en', 'fr'] })
        await addRow(wrapper)
        await pick(wrapper, 0, 'search-filter-mode', mode)
        await pick(wrapper, 0, 'search-filter-type', type)
        if (type === 'path' || type === 'tag') {
          await valueControl(wrapper, 0).setValue(value)
        } else {
          await pick(wrapper, 0, 'search-filter-value', value)
        }
        await settle()

        expect(filterParams(lastSearchParams())).toEqual([[name, value]])
      })
    }

    it('sends searchParams as an array of pairs, repeating a key per row', async () => {
      const { wrapper } = await mountSearch()
      await addRow(wrapper)
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')
      await valueControl(wrapper, 1).setValue('guides')
      await pick(wrapper, 1, 'search-filter-mode', 'exclude')
      await addRow(wrapper)
      await pick(wrapper, 2, 'search-filter-mode', 'exclude')
      await valueControl(wrapper, 2).setValue('drafts')
      await settle()

      const params = lastSearchParams()
      expect(Array.isArray(params)).toBe(true)
      expect(params.every((pair) => Array.isArray(pair) && pair.length === 2)).toBe(true)
      expect(filterParams(params)).toEqual([
        ['path', 'docs'],
        ['excludePath', 'guides'],
        ['excludePath', 'drafts']
      ])
    })
  })

  describe('the row count', () => {
    it('disables the add control at 20 rows and re-enables it after a removal', async () => {
      const { wrapper } = await mountSearch()
      for (let i = 0; i < 20; i++) {
        await addRow(wrapper)
      }
      const add = () => wrapper.find('[data-testid="search-filter-add"]')
      expect(rowsOf(wrapper)).toHaveLength(20)
      expect(add().attributes('disabled')).toBeDefined()

      await rowsOf(wrapper)[0].find('[data-testid="search-filter-remove"]').trigger('click')

      expect(rowsOf(wrapper)).toHaveLength(19)
      expect(add().attributes('disabled')).toBeUndefined()
    })

    it('removes exactly the clicked row, leaving the others in order', async () => {
      const { wrapper } = await mountSearch()
      for (const value of ['one', 'two', 'three']) {
        await addRow(wrapper)
        await valueControl(wrapper, wrapper.vm.state.filters.length - 1).setValue(value)
      }

      await rowsOf(wrapper)[1].find('[data-testid="search-filter-remove"]').trigger('click')
      await settle()

      expect(wrapper.vm.state.filters.map((r) => r.value)).toEqual(['one', 'three'])
      expect(filterParams(lastSearchParams())).toEqual([
        ['path', 'one'],
        ['path', 'three']
      ])
    })
  })

  describe('the filters-only guard while editing', () => {
    it('stops searching once the only include row is flipped to Exclude', async () => {
      const { wrapper } = await mountSearch({ initialPath: '/_search' })
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')
      await settle()
      expect(searchCalls()).toHaveLength(1)
      expect(searchCalls()[0][1].searchParams.map(([n]) => n)).not.toContain('query')

      API_CLIENT.get.mockClear()
      await pick(wrapper, 0, 'search-filter-mode', 'exclude')
      await settle()

      expect(searchCalls()).toHaveLength(0)
      expect(wrapper.vm.state.results).toEqual([])
    })
  })

  describe('persistence for a signed-in reader', () => {
    it('saves a row edited through the controls and restores it on a fresh mount', async () => {
      const first = await mountSearch({ authenticated: true })
      await addRow(first.wrapper)
      await pick(first.wrapper, 0, 'search-filter-mode', 'exclude')
      await valueControl(first.wrapper, 0).setValue('private')
      await settle()

      expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
      const [url, { json }] = API_CLIENT.put.mock.calls[0]
      expect(url).toBe('users/profile')
      expect(json).toEqual({ searchFilters: [{ mode: 'exclude', type: 'path', value: 'private' }] })

      first.wrapper.unmount()
      activeWrapper = null
      vi.clearAllMocks()

      const second = await mountSearch({
        authenticated: true,
        profile: { searchFilters: json.searchFilters }
      })

      expect(rowsOf(second.wrapper)).toHaveLength(1)
      expect(second.wrapper.vm.state.filters[0]).toMatchObject({
        mode: 'exclude',
        type: 'path',
        value: 'private'
      })
      expect(valueControl(second.wrapper, 0).element.value).toBe('private')
      expect(searchCalls()).toHaveLength(1)
      expect(filterParams(lastSearchParams())).toEqual([['excludePath', 'private']])
      expect(API_CLIENT.put).not.toHaveBeenCalled()
    })

    it('saves a mode flip on its own, without any change to the value', async () => {
      const { wrapper } = await mountSearch({
        authenticated: true,
        profile: { searchFilters: [{ mode: 'include', type: 'tag', value: 'alpha' }] }
      })
      expect(API_CLIENT.put).not.toHaveBeenCalled()

      await pick(wrapper, 0, 'search-filter-mode', 'exclude')
      await settle()

      expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile', {
        json: { searchFilters: [{ mode: 'exclude', type: 'tag', value: 'alpha' }] }
      })
    })

    it('saves one write for a burst of keystrokes, not one per key', async () => {
      const { wrapper } = await mountSearch({ authenticated: true })
      await addRow(wrapper)
      for (const text of ['d', 'do', 'doc', 'docs']) {
        await valueControl(wrapper, 0).setValue(text)
        await vi.advanceTimersByTimeAsync(100)
      }
      await settle()

      expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
      expect(API_CLIENT.put.mock.calls[0][1].json.searchFilters).toEqual([
        { mode: 'include', type: 'path', value: 'docs' }
      ])
    })

    it('tells the reader when the save fails, and keeps the row on screen', async () => {
      const { wrapper } = await mountSearch({ authenticated: true, putFails: true })
      await addRow(wrapper)
      await valueControl(wrapper, 0).setValue('docs')
      await settle()

      expect(notifications.some((n) => n.type === 'negative')).toBe(true)
      expect(rowsOf(wrapper)).toHaveLength(1)
      expect(filterParams(lastSearchParams())).toEqual([['path', 'docs']])
    })
  })

  describe('an anonymous reader', () => {
    it('applies rows to the search but never reads or writes the preference', async () => {
      const { wrapper } = await mountSearch({ authenticated: false })
      await addRow(wrapper)
      await pick(wrapper, 0, 'search-filter-mode', 'exclude')
      await valueControl(wrapper, 0).setValue('private')
      await settle(2000)

      expect(filterParams(lastSearchParams())).toEqual([['excludePath', 'private']])
      expect(API_CLIENT.get).not.toHaveBeenCalledWith('users/profile')
      expect(API_CLIENT.put).not.toHaveBeenCalled()
    })

    it('starts a fresh mount with no rows', async () => {
      const first = await mountSearch({ authenticated: false })
      await addRow(first.wrapper)
      await valueControl(first.wrapper, 0).setValue('private')
      await settle()
      first.wrapper.unmount()
      activeWrapper = null

      const second = await mountSearch({ authenticated: false })

      expect(rowsOf(second.wrapper)).toHaveLength(0)
      expect(filterParams(lastSearchParams())).toEqual([])
    })
  })
})
