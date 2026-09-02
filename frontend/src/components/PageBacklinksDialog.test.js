import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageBacklinksDialog from './PageBacklinksDialog.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #1917: the backlinks side panel, fetching `GET
 * sites/:siteId/pages/:pageId/backlinks` (#1914, `API_CLIENT` stubbed per `test/setup.js`) on mount
 * and rendering the empty state with no rows, one entry per source page otherwise -- each row a link
 * built through `localizedPagePath`, the same helper `HeaderSearch.vue`/`Search.vue` use.
 */
const REAL_STRINGS = {
  'editor.backlinks.title': 'Backlinks',
  'editor.backlinks.empty': 'No pages link to this page yet.',
  'common.actions.close': 'Close'
}

async function mountDialog(backlinks) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'docs/getting-started'
  pageStore.locale = 'en'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const router = await createTestRouter(['/:pathMatch(.*)*'])

  const i18n = createTestI18n(REAL_STRINGS)

  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve(backlinks)
  })

  const wrapper = mount(PageBacklinksDialog, {
    global: { plugins: [router, i18n] }
  })

  await flushPromises()

  return { wrapper, pageStore, siteStore }
}

describe('PageBacklinksDialog', () => {
  it('fetches backlinks for the current site and page', async () => {
    await mountDialog([])

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-1/backlinks')
  })

  it('renders the empty state when the endpoint returns no rows', async () => {
    const { wrapper } = await mountDialog([])

    expect(wrapper.text()).toContain('No pages link to this page yet.')
    expect(wrapper.findAll('.w-item')).toHaveLength(0)
  })

  it('renders one entry per source page when the endpoint returns rows', async () => {
    const { wrapper } = await mountDialog([
      { id: 'page-2', path: 'docs/intro', title: 'Intro', icon: null, locale: 'en' },
      { id: 'page-3', path: 'docs/setup', title: 'Setup', icon: null, locale: 'en' }
    ])

    expect(wrapper.text()).not.toContain('No pages link to this page yet.')
    const items = wrapper.findAll('.w-item')
    expect(items).toHaveLength(2)
    expect(wrapper.text()).toContain('Intro')
    expect(wrapper.text()).toContain('/docs/intro')
    expect(wrapper.text()).toContain('Setup')
    expect(wrapper.text()).toContain('/docs/setup')
  })

  it('links each row to its source page path', async () => {
    const { wrapper } = await mountDialog([
      { id: 'page-2', path: 'docs/intro', title: 'Intro', icon: null, locale: 'en' }
    ])

    // -> `siteStore.useLocales` (its `locales.active.length > 1` getter) is false by default in a
    //    freshly-created store, so `localizedPagePath` leaves the path unprefixed here.
    const link = wrapper.get('.w-item')
    expect(link.attributes('href')).toBe('/docs/intro')
  })

  it('closes the side panel when the close button is clicked', async () => {
    const { wrapper, siteStore } = await mountDialog([])
    siteStore.sideDialogShown = true

    await wrapper.get('[aria-label="Close"]').trigger('click')

    expect(siteStore.sideDialogShown).toBe(false)
  })
})
