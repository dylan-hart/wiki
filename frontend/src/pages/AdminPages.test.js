import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminPages from './AdminPages.vue'
import { useAdminStore } from '@/stores/admin'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * Coverage for OpenProject #1882's actual scope: row selection and the bulk delete/re-render/retag
 * plumbing on top of it. `AdminPages.vue`'s filters/paging (#1880's own scope, absorbed here since
 * that WP had not landed yet -- see the implementation-plan comment on #1882) are exercised only
 * enough to get rows on screen for the selection tests to act on.
 */

const rows = [
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

function mockEndpoints({ searchResults = rows } = {}) {
  globalThis.API_CLIENT.get.mockImplementation((url) => {
    const path = String(url)
    if (path.includes('pages/search')) {
      return {
        json: () => Promise.resolve({ results: searchResults, totalHits: searchResults.length })
      }
    }
    // -> The site lookup `loadSiteLocales()` makes, for the locale filter's options
    return { json: () => Promise.resolve({ locales: { active: ['en'] } }) }
  })
}

async function mountPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'
  adminStore.locales = [{ code: 'en', name: 'English', nativeName: 'English' }]

  mockEndpoints()

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminPages, { global: { plugins: [router, i18n] } })
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

describe('AdminPages: row selection', () => {
  it('renders one row per result, none selected to start with', async () => {
    const { wrapper } = await mountPage()
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeUndefined()
  })

  it('checking one row shows the bulk-action toolbar with a count of 1', async () => {
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    expect(wrapper.text()).toContain('admin.pages.selectedCount')
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeDefined()
  })

  it('"select all on this page" selects every visible row, and toggling it again clears them', async () => {
    const { wrapper } = await mountPage()
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
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeDefined()

    await wrapper.find('[aria-label="common.actions.refresh"]').trigger('click')
    await flushPromises()

    expect(findButtonByText(wrapper, 'admin.pages.bulkDelete')).toBeUndefined()
  })
})

describe('AdminPages: bulk delete', () => {
  it('confirms the count, then posts the selected ids with action delete', async () => {
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    globalThis.API_CLIENT.post.mockReturnValueOnce({
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

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'delete' }
    })
    expect(notifyQueue.at(-1).type).toBe('positive')
  })

  it('a mixed-outcome response (some skipped) still notifies, as a warning rather than an error', async () => {
    const { wrapper } = await mountPage()
    const checkboxes = wrapper.findAll('[role="checkbox"]')
    await checkboxes[0].trigger('click') // select-all-on-page

    globalThis.API_CLIENT.post.mockReturnValueOnce({
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
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')

    globalThis.API_CLIENT.post.mockReturnValueOnce({
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

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'render' }
    })
  })
})

describe('AdminPages: bulk retag', () => {
  it('opens an inline panel, and posts split, trimmed add/remove tag lists', async () => {
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    await findButtonByText(wrapper, 'admin.pages.bulkRetag').trigger('click')

    // -> The retag panel's two inputs are the last two rendered once it opens (add, then remove).
    const inputs = wrapper.findAll('input')
    const addField = inputs.at(-2)
    const removeField = inputs.at(-1)
    await addField.setValue(' c , d ')
    await removeField.setValue('a')

    globalThis.API_CLIENT.post.mockReturnValueOnce({
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

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/bulk', {
      json: { pageIds: ['page-1'], action: 'retag', addTags: ['c', 'd'], removeTags: ['a'] }
    })
  })

  it('refuses to submit with neither add nor remove tags provided', async () => {
    const { wrapper } = await mountPage()
    await rowCheckboxes(wrapper)[0].trigger('click')
    await findButtonByText(wrapper, 'admin.pages.bulkRetag').trigger('click')

    await findButtonByText(wrapper, 'admin.pages.retagApply').trigger('click')
    await flushPromises()

    expect(globalThis.API_CLIENT.post).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)?.message).toBe('admin.pages.retagNoneProvided')
  })
})
