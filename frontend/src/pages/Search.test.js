import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'

import Search from './Search.vue'
import { useSiteStore } from '@/stores/site'

const messages = {
  en: {
    'search.loadMore': 'Load More'
  }
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', fallbackWarn: false, messages })
}

const FIXTURE_PAGE_A = {
  id: 'p1',
  path: 'page-a',
  locale: 'en',
  title: 'Page A',
  description: null,
  icon: null,
  tags: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: null
}

const FIXTURE_PAGE_B = { ...FIXTURE_PAGE_A, id: 'p2', path: 'page-b', title: 'Page B' }
const FIXTURE_PAGE_C = { ...FIXTURE_PAGE_A, id: 'p3', path: 'page-c', title: 'Page C' }

async function createTestRouter(initialPath) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/_search', component: Search },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  })
  router.push(initialPath)
  await router.isReady()
  return router
}

/**
 * Mounts against `initialPath`, queuing `firstResponse` ahead of the immediate `route.query`
 * watcher's own search request -- the same mount-time ordering `TagsBrowse.test.js` documents for
 * its own route-driven watcher.
 */
async function mountSearch(initialPath = '/_search?q=test', firstResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  if (firstResponse) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(firstResponse) })
  }

  const router = await createTestRouter(initialPath)
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createTestI18n()],
      // -> Layout chrome, irrelevant to offset paging. HeaderNav in particular pulls in
      //    HeaderSearch, whose onMounted() unconditionally focuses its search field whenever the
      //    route starts with `/_search` -- exactly this page's own route -- which throws under
      //    happy-dom with nothing real to focus.
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  await flushPromises()
  return { wrapper, router, siteStore }
}

function findLoadMoreButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === 'Load More')
}

describe('Search.vue offset paging (OpenProject #2001)', () => {
  it('sends offset 0 on the first page of a fresh search', async () => {
    const { wrapper } = await mountSearch('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(wrapper.vm.state.offset).toBe(2)
  })

  it('loadMore requests the next page at the current offset and appends rather than replaces', async () => {
    const { wrapper } = await mountSearch('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 3, suggestion: null })
    })

    await wrapper.vm.loadMore()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 2 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1', 'p2', 'p3'])
    expect(wrapper.vm.state.offset).toBe(3)
  })

  it('shows the load-more control while more results remain, and hides it once exhausted', async () => {
    const { wrapper } = await mountSearch('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })
    expect(findLoadMoreButton(wrapper)).toBeTruthy()

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 3, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('never shows the load-more control when a single page already covers the total', async () => {
    const { wrapper } = await mountSearch('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 2,
      suggestion: null
    })

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('a fresh search resets the offset instead of continuing to append onto the prior one', async () => {
    const { wrapper } = await mountSearch('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 5,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()
    expect(wrapper.vm.state.offset).toBe(3)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.performSearch()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
    expect(wrapper.vm.state.offset).toBe(1)
  })
})
