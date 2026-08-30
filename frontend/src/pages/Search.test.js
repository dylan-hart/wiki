import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'

import Search from './Search.vue'
import { useSiteStore } from '@/stores/site'

/**
 * OpenProject #2006: a restricted reader's page rules can drop rows the search engine itself
 * matched, which makes the reported `totalHits` a floor rather than an exact count -- see
 * `backend/modules/search/db/search.test.ts` for the backend half (the flag itself) and this file
 * for the frontend half (labeling it). Real i18n messages, not the empty stub `TagsBrowse.test.js`
 * uses, since what is under test here IS the wording the two keys (`search.totalResults` /
 * `search.totalResultsApprox`) produce.
 */
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackWarn: false,
    messages: {
      en: {
        search: {
          results: 'Search Results',
          emptyQuery: 'Enter a query in the search field above and press Enter.',
          totalResults: 'No result | {0} result | {0} results',
          totalResultsApprox: 'No result | At least {0} result | At least {0} results'
        }
      }
    }
  })
}

const FIXTURE_PAGE = {
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

async function mountSearch(searchResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })

  const router = await createTestRouter('/_search?q=onboarding')
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createTestI18n()],
      // -> Real HeaderNav/FooterNav/MainOverlayDialog pull in more stores and API calls than this
      //    test cares about; stubbed by name so the page around them still renders for real.
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  await flushPromises()
  return { wrapper, siteStore }
}

describe('Search.vue totalHitsApproximate labeling (OpenProject #2006)', () => {
  it('shows the exact-count label when the backend reports an exact total', async () => {
    const { wrapper } = await mountSearch({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.vm.state.totalApproximate).toBe(false)
    expect(wrapper.text()).toContain('1 result')
    expect(wrapper.text()).not.toContain('At least')
  })

  it('shows the approximate-count label when page rules dropped rows from this page', async () => {
    const { wrapper } = await mountSearch({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: true,
      suggestion: null
    })

    expect(wrapper.vm.state.totalApproximate).toBe(true)
    expect(wrapper.text()).toContain('At least 1 result')
  })

  it('resets to the exact label on a later search that reports nothing approximate', async () => {
    const { wrapper, siteStore } = await mountSearch({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: true,
      suggestion: null
    })
    expect(wrapper.vm.state.totalApproximate).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [FIXTURE_PAGE],
          totalHits: 1,
          totalHitsApproximate: false,
          suggestion: null
        })
    })
    siteStore.search = 'onboarding guide'
    await wrapper.vm.performSearch()
    await flushPromises()

    expect(wrapper.vm.state.totalApproximate).toBe(false)
    expect(wrapper.text()).not.toContain('At least')
  })
})
