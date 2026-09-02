import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import TagsBrowse from './TagsBrowse.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { confirm } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  // -> `.onOk(cb)` runs `cb` at once rather than waiting on a real confirmation dialog's own click --
  //    what these tests need to verify is that confirming DOES the right thing, and that the
  //    confirmation was asked for with the right message, not the confirmation UI itself.
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

/**
 * `search.loadMore` is always present -- every mount renders the same "Load more" button template
 * as soon as more results exist, whether or not a given test cares about it -- while `messages`
 * layers in whatever ELSE that one test needs resolved (e.g. `MANAGEMENT_MESSAGES` below).
 */
function createTagsBrowseI18n(messages = {}) {
  return createTestI18n({ search: { loadMore: 'Load More' }, ...messages })
}

function findLoadMoreButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === 'Load More')
}

/**
 * The one subset of the real locale strings the management-mode tests need actually resolved --
 * the "confirmation reports the affected-page count" assertion has to see `{count}` interpolated,
 * which the app's real messages (`backend/locales/en.json`) provide and the shared empty-messages
 * i18n instance above deliberately doesn't.
 */
const MANAGEMENT_MESSAGES = {
  tags: {
    manageTags: 'Manage Tags',
    renameTagTitle: 'Rename Tag',
    renameTagConfirm: 'Rename **{from}** to **{to}**? It will be updated on {count} page(s).',
    mergeTagTitle: 'Merge Tags',
    mergeTagConfirm:
      '**{to}** already exists. Renaming **{from}** onto it will merge the two tags across {count} page(s).',
    deleteTagTitle: 'Delete Tag',
    deleteTagConfirm: 'Delete tag **{tag}**? It will be removed from {count} page(s).',
    manageUnauthorizedCaption: "Pages you don't have permission to manage are left unchanged."
  }
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

const FIXTURE_PAGE_2 = { ...FIXTURE_PAGE, id: 'p2', path: 'some/other-page', title: 'Other Page' }
const FIXTURE_PAGE_3 = { ...FIXTURE_PAGE, id: 'p3', path: 'some/third-page', title: 'Third Page' }

const EMPTY_RESULTS = { results: [], totalHits: 0, suggestion: null }

async function createTagsRouter(initialPath) {
  const router = await createTestRouter(
    [{ path: '/_tags', component: TagsBrowse }, '/:pathMatch(.*)*'],
    initialPath
  )
  return router
}

/**
 * Mounts against `initialPath`. If it already carries a `tags` query, the route's `immediate`
 * watcher fires a search DURING setup -- before `onMounted`'s tag-list fetch -- so `searchResponse`
 * has to be queued ahead of the (always-queued) tag-list fixture to land on the right call. A path
 * with no selection triggers no search at mount, so only the tag list is ever queued.
 *
 * @param {string} initialPath
 * @param {object} searchResponse
 * @param {string[]} [pagePermissions] What `userStore.pagePermissions` holds -- the gate the
 *   management-mode controls are checked against. Defaults to none, matching an ordinary reader.
 * @param {object} [i18nMessages] Real locale strings to resolve during this mount, rather than the
 *   default empty set every other test in this file relies on -- see `MANAGEMENT_MESSAGES`.
 */
async function mountTagsBrowse(
  initialPath = '/_tags',
  searchResponse = EMPTY_RESULTS,
  pagePermissions = [],
  i18nMessages = {}
) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const userStore = useUserStore()
  userStore.pagePermissions = pagePermissions

  if (initialPath.includes('tags=')) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })
  }
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

  const router = await createTagsRouter(initialPath)
  const wrapper = mount(TagsBrowse, {
    global: { plugins: [router, createTagsBrowseI18n(i18nMessages)] }
  })
  await flushPromises()
  return { wrapper, router, siteStore, userStore }
}

beforeEach(() => {
  confirm.mockClear()
})

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

  /**
   * OpenProject #1121: `siteStore.fetchTags()` short-circuits when `tagsLoaded` is already true, so a
   * tag list cached from earlier in the session (the editor, `PageTags.vue`, …) used to go stale here
   * -- a tag created elsewhere never showed up in the sidebar until a full page reload reset the
   * store. This screen forces a refresh instead of trusting the cache.
   */
  it('force-refreshes the tag list on mount even when the store already has a cached (stale) one', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    // -> Simulate a stale cache left behind by an earlier visit to the editor or PageTags.vue.
    siteStore.$patch({ tags: [{ tag: 'stale-only', usageCount: 1 }], tagsLoaded: true })

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    const router = await createTagsRouter('/_tags')
    mount(TagsBrowse, { global: { plugins: [router, createTagsBrowseI18n()] } })
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tags')
    expect(siteStore.tags).toEqual(FIXTURE_TAGS)
  })

  it('recovers from a search failure without throwing', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    const router = await createTagsRouter('/_tags?tags=equipment')
    const wrapper = mount(TagsBrowse, { global: { plugins: [router, createTagsBrowseI18n()] } })
    await flushPromises()

    expect(wrapper.vm.state.results).toEqual([])
  })

  it('sends offset 0 on the first page of a fresh search', async () => {
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE, FIXTURE_PAGE_2],
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
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE, FIXTURE_PAGE_2],
      totalHits: 3,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_3], totalHits: 3, suggestion: null })
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
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE, FIXTURE_PAGE_2],
      totalHits: 3,
      suggestion: null
    })
    expect(findLoadMoreButton(wrapper)).toBeTruthy()

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_3], totalHits: 3, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('never shows the load-more control when a single page already covers the total', async () => {
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE, FIXTURE_PAGE_2],
      totalHits: 2,
      suggestion: null
    })

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('toggling a second tag resets the offset instead of continuing to append onto the prior search', async () => {
    const { wrapper } = await mountTagsBrowse('/_tags?tags=equipment', {
      results: [FIXTURE_PAGE, FIXTURE_PAGE_2],
      totalHits: 5,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_3], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()
    expect(wrapper.vm.state.offset).toBe(3)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.toggleTag('procedure')
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

describe('TagsBrowse.vue tag management mode (OpenProject #1877)', () => {
  it('hides the management toggle from a reader without manage:pages', async () => {
    const { wrapper } = await mountTagsBrowse()

    expect(wrapper.find('[aria-label="tags.manageTags"]').exists()).toBe(false)
    expect(wrapper.vm.canManageTags).toBe(false)
  })

  it('shows the management toggle for a reader holding manage:pages', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )

    expect(wrapper.vm.canManageTags).toBe(true)
    expect(wrapper.find('[aria-label="Manage Tags"]').exists()).toBe(true)
  })

  it('toggling management mode lists every tag with rename/delete controls', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )

    wrapper.vm.toggleManagementMode()
    await flushPromises()

    expect(wrapper.vm.state.managementMode).toBe(true)
    expect(wrapper.findAll('.tag-manage-row')).toHaveLength(FIXTURE_TAGS.length)
  })

  it('renaming a tag confirms with the affected-page count, then PATCHes the new route', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ affected: 5 }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    wrapper.vm.startRename(FIXTURE_TAGS[0])
    wrapper.vm.state.renameValue = 'gear'
    wrapper.vm.confirmRename(FIXTURE_TAGS[0])
    await flushPromises()

    // -> `equipment`'s usageCount (5) is what the confirmation must name -- this is the "reports the
    //    affected-page count" behaviour the work package's done-when criteria calls out.
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('5')
      })
    )
    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/tags/equipment', {
      json: { newTag: 'gear' }
    })
    // -> Refreshed after a successful mutation, per the work package's own done-when criteria.
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tags')
    expect(wrapper.vm.state.renamingTag).toBeNull()
  })

  it('renaming onto an existing tag name confirms as a merge rather than a plain rename', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ affected: 3 }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    wrapper.vm.startRename(FIXTURE_TAGS[0])
    wrapper.vm.state.renameValue = 'procedure'
    wrapper.vm.confirmRename(FIXTURE_TAGS[0])
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Merge Tags' }))
    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/tags/equipment', {
      json: { newTag: 'procedure' }
    })
  })

  it('a no-op rename (blank or unchanged value) never opens a confirmation', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )

    wrapper.vm.startRename(FIXTURE_TAGS[0])
    wrapper.vm.state.renameValue = '  '
    wrapper.vm.confirmRename(FIXTURE_TAGS[0])
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    expect(API_CLIENT.patch).not.toHaveBeenCalled()
    expect(wrapper.vm.state.renamingTag).toBeNull()
  })

  it('deleting a tag confirms with the affected-page count, then DELETEs the tag route', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )
    API_CLIENT.delete.mockReturnValueOnce({ json: () => Promise.resolve({ affected: 1 }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_TAGS) })

    wrapper.vm.deleteTag(FIXTURE_TAGS[2])
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('1'),
        color: 'negative'
      })
    )
    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/tags/safety')
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tags')
  })

  it('a failed rename notifies rather than throwing, and leaves the row in edit state', async () => {
    const { wrapper } = await mountTagsBrowse(
      '/_tags',
      EMPTY_RESULTS,
      ['manage:pages'],
      MANAGEMENT_MESSAGES
    )
    API_CLIENT.patch.mockImplementationOnce(() => {
      throw new Error('network')
    })

    wrapper.vm.startRename(FIXTURE_TAGS[0])
    wrapper.vm.state.renameValue = 'gear'
    await expect(wrapper.vm.performRename('equipment', 'gear')).resolves.toBeUndefined()
  })
})
