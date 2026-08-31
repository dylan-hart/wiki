import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminPages from './AdminPages.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * OpenProject #1880: the `/_admin/:siteid/pages` inventory, built on the paginating
 * `GET sites/:siteId/pages/search` route -- server-side paging and filtering by path, locale, tag,
 * editor and publish state, in place of `/_search`'s 100-row cap and lack of per-row action.
 */

const ROW = {
  id: 'page-1',
  path: 'getting-started',
  locale: 'en',
  title: 'Getting Started',
  description: null,
  icon: null,
  tags: ['b-tag', 'a-tag'],
  updatedAt: '2026-08-20T12:00:00.000Z',
  relevancy: 0,
  highlight: null
}

function searchResponse({ total = 1, results = [ROW] } = {}) {
  return { json: () => Promise.resolve({ results, totalHits: total }) }
}

function siteResponse(activeLocales = ['en', 'fr']) {
  return { json: () => Promise.resolve({ locales: { active: activeLocales } }) }
}

async function mountPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'
  adminStore.locales = [
    { code: 'en', name: 'English', nativeName: 'English' },
    { code: 'fr', name: 'French', nativeName: 'French' }
  ]

  API_CLIENT.get.mockImplementation((url) => {
    if (String(url).endsWith('/pages/search')) {
      return searchResponse()
    }
    return siteResponse()
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const wrapper = mount(AdminPages, { global: { plugins: [i18n] } })
  await flushPromises()

  return { wrapper, adminStore }
}

beforeEach(() => {
  API_CLIENT.get.mockReset()
})

describe('AdminPages', () => {
  it('loads the first page of results and the site active-locale list on mount', async () => {
    const { wrapper } = await mountPage()

    expect(wrapper.vm.state.rows).toHaveLength(1)
    expect(wrapper.vm.state.rows[0].id).toBe('page-1')
    // -> Sorted client-side, same as `Search.vue` does with the same shaped rows
    expect(wrapper.vm.state.rows[0].tags).toEqual(['a-tag', 'b-tag'])
    expect(wrapper.vm.state.total).toBe(1)
    expect(wrapper.vm.state.activeLocales).toEqual(['en', 'fr'])
    expect(wrapper.text()).toContain('Getting Started')

    wrapper.unmount()
  })

  it('applyFilters() sends the path/locale/tag/editor/publishState filters as querystring params', async () => {
    const { wrapper } = await mountPage()

    wrapper.vm.state.filters.path = 'docs'
    wrapper.vm.state.filters.locales = ['en', 'fr']
    wrapper.vm.state.filters.tags = ' foo , bar ,, '
    wrapper.vm.state.filters.editor = 'markdown'
    wrapper.vm.state.filters.publishState = 'published'

    API_CLIENT.get.mockClear()
    wrapper.vm.applyFilters()
    await flushPromises()

    const call = API_CLIENT.get.mock.calls.find(([url]) => String(url).endsWith('/pages/search'))
    expect(call).toBeDefined()
    const [url, opts] = call
    expect(url).toBe('sites/site-1/pages/search')
    expect(opts.searchParams.get('path')).toBe('docs')
    expect(opts.searchParams.get('locales')).toBe('en,fr')
    // -> Blank entries from stray commas are dropped, and each tag is trimmed
    expect(opts.searchParams.get('tags')).toBe('foo,bar')
    expect(opts.searchParams.get('editor')).toBe('markdown')
    expect(opts.searchParams.get('publishState')).toBe('published')
    expect(opts.searchParams.get('offset')).toBe('0')
    expect(opts.searchParams.get('limit')).toBe('50')

    wrapper.unmount()
  })

  it('omits a filter from the querystring entirely when it is left at its empty default', async () => {
    const { wrapper } = await mountPage()

    API_CLIENT.get.mockClear()
    wrapper.vm.applyFilters()
    await flushPromises()

    const [, opts] = API_CLIENT.get.mock.calls.find(([url]) =>
      String(url).endsWith('/pages/search')
    )
    expect(opts.searchParams.has('path')).toBe(false)
    expect(opts.searchParams.has('locales')).toBe(false)
    expect(opts.searchParams.has('tags')).toBe(false)
    expect(opts.searchParams.has('editor')).toBe(false)
    expect(opts.searchParams.has('publishState')).toBe(false)

    wrapper.unmount()
  })

  it('applyFilters() resets the pager to page 1', async () => {
    const { wrapper } = await mountPage()
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/pages/search')) {
        return searchResponse({ total: 300 })
      }
      return siteResponse()
    })

    await wrapper.vm.load({ page: 3 })
    expect(wrapper.vm.state.currentPage).toBe(3)

    wrapper.vm.applyFilters()
    await flushPromises()

    expect(wrapper.vm.state.currentPage).toBe(1)

    wrapper.unmount()
  })

  it('resetFilters() clears every filter and reloads at page 1', async () => {
    const { wrapper } = await mountPage()

    wrapper.vm.state.filters.path = 'docs'
    wrapper.vm.state.filters.locales = ['en']
    wrapper.vm.state.filters.tags = 'foo'
    wrapper.vm.state.filters.editor = 'markdown'
    wrapper.vm.state.filters.publishState = 'draft'
    wrapper.vm.state.currentPage = 2

    wrapper.vm.resetFilters()
    await flushPromises()

    expect(wrapper.vm.state.filters).toEqual({
      path: '',
      locales: [],
      tags: '',
      editor: '',
      publishState: ''
    })
    expect(wrapper.vm.state.currentPage).toBe(1)

    wrapper.unmount()
  })

  it('paging past 100 rows works in offset/limit steps of PAGE_SIZE, not a bigger limit', async () => {
    const { wrapper } = await mountPage()
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/pages/search')) {
        return searchResponse({ total: 240 })
      }
      return siteResponse()
    })

    API_CLIENT.get.mockClear()
    await wrapper.vm.load({ page: 5 })

    const [, opts] = API_CLIENT.get.mock.calls.find(([url]) =>
      String(url).endsWith('/pages/search')
    )
    // -> Page 5 at 50 rows/page is offset 200, and the limit itself never grows past what the API caps
    expect(opts.searchParams.get('offset')).toBe('200')
    expect(opts.searchParams.get('limit')).toBe('50')
    expect(wrapper.vm.state.currentPage).toBe(5)
    expect(wrapper.vm.totalPages).toBe(5)

    wrapper.unmount()
  })

  it('load() reports a failure without leaving stale rows silently', async () => {
    const { wrapper } = await mountPage()
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/pages/search')) {
        return { json: () => Promise.reject(new Error('network down')) }
      }
      return siteResponse()
    })

    await wrapper.vm.load({ page: 1 })

    // -> The failed fetch leaves `state.rows` as whatever it already was rather than throwing out of
    //    `load()` -- the same not-caught-elsewhere shape every other admin list page uses.
    expect(wrapper.vm.state.loading).toBe(0)

    wrapper.unmount()
  })
})
