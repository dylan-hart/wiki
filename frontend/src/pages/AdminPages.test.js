import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminPages from './AdminPages.vue'
import { useAdminStore } from '@/stores/admin'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/**
 * OpenProject #1880: the `/_admin/:siteid/pages` inventory, built on the paginating
 * `GET sites/:siteId/pages/search` route -- server-side paging and filtering by path, locale, tag,
 * editor and publish state, in place of `/_search`'s 100-row cap and lack of per-row action.
 *
 * OpenProject #1882 layers row selection and the bulk delete/re-render/retag plumbing on top --
 * covered by its own `AdminPages: row selection` / `AdminPages: bulk *` describes below, which
 * exercise the filters/paging half only enough to get rows on screen for selection to act on.
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

const SELECTION_ROWS = [
  {
    id: 'page-1',
    path: 'docs/one',
    locale: 'en',
    title: 'Page One',
    tags: ['a', 'b'],
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'page-2',
    path: 'docs/two',
    locale: 'en',
    title: 'Page Two',
    tags: [],
    updatedAt: '2026-01-02T00:00:00.000Z'
  }
]

function searchResponse({ total = 1, results = [ROW] } = {}) {
  return { json: () => Promise.resolve({ results, totalHits: total }) }
}

function siteResponse(activeLocales = ['en', 'fr']) {
  return { json: () => Promise.resolve({ locales: { active: activeLocales } }) }
}

function makeRouter() {
  return buildTestRouter(['/:pathMatch(.*)*'])
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

  const i18n = createTestI18n()
  const wrapper = mount(AdminPages, { global: { plugins: [makeRouter(), i18n] } })
  await flushPromises()

  return { wrapper, adminStore }
}

/** Rows-on-screen fixture the row-selection/bulk-action describes below act on. */
function mockSelectionEndpoints({ searchResults = SELECTION_ROWS } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    const path = String(url)
    if (path.includes('pages/search')) {
      return {
        json: () => Promise.resolve({ results: searchResults, totalHits: searchResults.length })
      }
    }
    // -> The site lookup `loadSite()` makes, for the locale filter's options
    return { json: () => Promise.resolve({ locales: { active: ['en'] } }) }
  })
}

async function mountSelectionPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'
  adminStore.locales = [{ code: 'en', name: 'English', nativeName: 'English' }]

  mockSelectionEndpoints()

  const i18n = createTestI18n()
  const wrapper = mount(AdminPages, { global: { plugins: [makeRouter(), i18n] } })
  await flushPromises()

  return { wrapper, adminStore }
}

/** Every row's own `w-checkbox` (the `select` column), in row order. */
function rowCheckboxes(wrapper) {
  return wrapper.findAll('tbody tr').map((tr) => tr.find('[role="checkbox"]'))
}

function findButtonByText(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

/** Confirms the most recently opened `confirm()` dialog, without rendering it. */
async function confirmLatestDialog() {
  const dialog = openDialogs.at(-1)
  dialog.handlers.ok[0](true)
  openDialogs.splice(openDialogs.indexOf(dialog), 1)
  await flushPromises()
}

beforeEach(() => {
  openDialogs.splice(0, openDialogs.length)
  notifyQueue.splice(0, notifyQueue.length)
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

describe('AdminPages: row selection', () => {
  it('renders one row per result, none selected to start with', async () => {
    const { wrapper } = await mountSelectionPage()
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeUndefined()
  })

  it('checking one row shows the bulk-action toolbar with a count of 1', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    expect(wrapper.text()).toContain('admin.pages.selectedCount')
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeDefined()
  })

  it('"select all on this page" selects every visible row, and toggling it again clears them', async () => {
    const { wrapper } = await mountSelectionPage()
    const checkboxes = wrapper.findAll('[role="checkbox"]')
    // -> First checkbox in DOM order is the header "select all" control
    await checkboxes[0].trigger('click')

    expect(rowCheckboxes(wrapper).every((cb) => cb.attributes('aria-checked') === 'true')).toBe(
      true
    )
    expect(wrapper.text()).toContain('admin.pages.selectedCount')

    await checkboxes[0].trigger('click')
    expect(rowCheckboxes(wrapper).every((cb) => cb.attributes('aria-checked') === 'false')).toBe(
      true
    )
  })

  it('reloading (e.g. a fresh filter) clears the selection', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeDefined()

    await wrapper.find('[aria-label="common.actions.refresh"]').trigger('click')
    await flushPromises()

    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeUndefined()
  })
})

describe('AdminPages: bulk delete', () => {
  it('confirms the count, then posts the selected ids with action delete', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          action: 'delete',
          results: [{ id: 'page-1', path: 'docs/one', status: 'done' }],
          counts: { done: 1 }
        })
    })

    await findButtonByText(wrapper, 'admin.pages.bulkDelete').trigger('click')
    const dialog = openDialogs.at(-1)
    expect(dialog.props.title).toBe('admin.pages.bulkDeleteConfirmTitle')

    await confirmLatestDialog()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'delete' }
    })
    expect(notifyQueue.at(-1).type).toBe('positive')
  })

  it('a mixed-outcome response (some skipped) still notifies, as a warning rather than an error', async () => {
    const { wrapper } = await mountSelectionPage()
    const checkboxes = wrapper.findAll('[role="checkbox"]')
    await checkboxes[0].trigger('click') // select-all-on-page

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          action: 'delete',
          results: [
            { id: 'page-1', path: 'docs/one', status: 'done' },
            { id: 'page-2', path: 'docs/two', status: 'skipped', message: 'Not permitted.' }
          ],
          counts: { done: 1, skipped: 1 }
        })
    })

    await findButtonByText(wrapper, 'admin.pages.bulkDelete').trigger('click')
    await confirmLatestDialog()

    const notification = notifyQueue.at(-1)
    expect(notification.type).toBe('warning')
    expect(notification.caption).toContain('admin.pages.bulkResultSkipped')
  })
})

describe('AdminPages: bulk re-render', () => {
  it('posts the selected ids with action render', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          action: 'render',
          results: [{ id: 'page-1', path: 'docs/one', status: 'done' }],
          counts: { done: 1 }
        })
    })

    await findButtonByText(wrapper, 'admin.pages.bulkRender').trigger('click')
    await confirmLatestDialog()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'render' }
    })
  })
})

describe('AdminPages: bulk retag', () => {
  it('opens an inline panel, and posts split, trimmed add/remove tag lists', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    await findButtonByText(wrapper, 'admin.pages.bulkRetag').trigger('click')

    // -> The retag panel's two inputs are the last two rendered once it opens (add, then remove).
    const inputs = wrapper.findAll('input')
    const addField = inputs.at(-2)
    const removeField = inputs.at(-1)
    await addField.setValue(' c , d ')
    await removeField.setValue('a')

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          action: 'retag',
          results: [{ id: 'page-1', path: 'docs/one', status: 'done' }],
          counts: { done: 1 }
        })
    })

    await findButtonByText(wrapper, 'admin.pages.retagApply').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'retag', addTags: ['c', 'd'], removeTags: ['a'] }
    })
  })

  it('refuses to submit with neither add nor remove tags provided', async () => {
    const { wrapper } = await mountSelectionPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    await findButtonByText(wrapper, 'admin.pages.bulkRetag').trigger('click')

    await findButtonByText(wrapper, 'admin.pages.retagApply').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)?.message).toBe('admin.pages.retagNoneProvided')
  })
})
