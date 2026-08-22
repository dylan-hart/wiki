import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'

import TagsBrowse from './TagsBrowse.vue'
import { useSiteStore } from '@/stores/site'

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', fallbackWarn: false, messages: { en: {} } })
}

const FIXTURE_TAGS = [
  { tag: 'equipment', usageCount: 5 },
  { tag: 'procedure', usageCount: 3 },
  { tag: 'safety', usageCount: 1 }
]

const FIXTURE_PAGE = {
  id: 'p1',
  path: 'some/page',
  locale: 'en',
  title: 'Some Page',
  description: null,
  icon: null,
  tags: ['equipment', 'procedure'],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: null
}

const EMPTY_RESULTS = { results: [], totalHits: 0, suggestion: null }

async function createTestRouter(initialPath) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/_tags', component: TagsBrowse },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  })
  router.push(initialPath)
  await router.isReady()
  return router
}

/**
 * Mounts against `initialPath`. If it already carries a `tags` query, the route's `immediate`
 * watcher fires a search DURING setup -- before `onMounted`'s tag-list fetch -- so `searchResponse`
 * has to be queued ahead of the (always-queued) tag-list fixture to land on the right call. A path
 * with no selection triggers no search at mount, so only the tag list is ever queued.
 */
async function mountTagsBrowse(initialPath = '/_tags', searchResponse = EMPTY_RESULTS) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  if (initialPath.includes('tags=')) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })
  }
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

  const router = await createTestRouter(initialPath)
  const wrapper = mount(TagsBrowse, { global: { plugins: [router, createTestI18n()] } })
  await flushPromises()
  return { wrapper, router, siteStore }
}

describe('TagsBrowse.vue (OpenProject #987)', () => {
  it('fetches the site tag list on mount', async () => {
    const { siteStore } = await mountTagsBrowse()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tags')
    expect(siteStore.tags).toEqual(FIXTURE_TAGS)
  })

  it('runs no search while no tag is selected', async () => {
    await mountTagsBrowse()

    expect(API_CLIENT.get).not.toHaveBeenCalledWith('sites/site-1/pages/search', expect.anything())
  })

  it('hydrates the selection from the route query and searches by that tag', async () => {
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE],
      totalHits: 1,
      suggestion: null
    })

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ tags: 'equipment' })
      })
    )
    expect(wrapper.vm.state.results).toHaveLength(1)
    expect(wrapper.vm.state.results[0].id).toBe('p1')
  })

  it('clicking a tag chip pushes it onto the route and re-searches', async () => {
    const { wrapper, router } = await mountTagsBrowse()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE], totalHits: 1, suggestion: null })
    })

    await wrapper.vm.toggleTag('equipment')
    await flushPromises()

    expect(router.currentRoute.value.query.tags).toBe('equipment')
    expect(wrapper.vm.state.selectedTags).toEqual(['equipment'])
    expect(wrapper.vm.state.results).toHaveLength(1)
  })

  it('selecting a second tag is an AND -- both are sent, narrowing rather than widening', async () => {
    const { wrapper } = await mountTagsBrowse()
    API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(EMPTY_RESULTS) })

    await wrapper.vm.toggleTag('equipment')
    await flushPromises()
    await wrapper.vm.toggleTag('procedure')
    await flushPromises()

    expect(wrapper.vm.state.selectedTags).toEqual(['equipment', 'procedure'])
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ tags: 'equipment,procedure' })
      })
    )
  })

  it('toggling an already-selected tag removes it from the selection', async () => {
    const { wrapper, router } = await mountTagsBrowse('/_tags?tags=equipment,procedure')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(EMPTY_RESULTS) })

    await wrapper.vm.toggleTag('equipment')
    await flushPromises()

    expect(wrapper.vm.state.selectedTags).toEqual(['procedure'])
    expect(router.currentRoute.value.query.tags).toBe('procedure')
  })

  it('clearSelection empties the selection and the route query, with no further search', async () => {
    const { wrapper, router } = await mountTagsBrowse('/_tags?tags=equipment,procedure')

    await wrapper.vm.clearSelection()
    await flushPromises()

    expect(wrapper.vm.state.selectedTags).toEqual([])
    expect(wrapper.vm.state.results).toEqual([])
    expect(router.currentRoute.value.query.tags).toBeUndefined()
  })

  it('defaults order direction per field -- title ascending, everything else newest-first', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
        results: [FIXTURE_PAGE],
        totalHits: 1,
        suggestion: null
      })

      expect(API_CLIENT.get).toHaveBeenCalledWith(
        'sites/site-1/pages/search',
        expect.objectContaining({
          searchParams: expect.objectContaining({ orderBy: 'title', orderByDirection: 'asc' })
        })
      )

      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(EMPTY_RESULTS) })
      wrapper.vm.state.orderBy = 'updatedAt'
      await vi.advanceTimersByTimeAsync(400)

      expect(API_CLIENT.get).toHaveBeenLastCalledWith(
        'sites/site-1/pages/search',
        expect.objectContaining({
          searchParams: expect.objectContaining({ orderBy: 'updatedAt', orderByDirection: 'desc' })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from a search failure without throwing', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    const router = await createTestRouter('/_tags?tags=equipment')
    const wrapper = mount(TagsBrowse, { global: { plugins: [router, createTestI18n()] } })
    await flushPromises()

    expect(wrapper.vm.state.results).toEqual([])
  })
})
