import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

import Search from './Search.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

vi.mock('@/composables/screen', () => ({
  useMinWidth: () => ref(false),
  useScreen: () => ({ gte: { sm: false, md: false, lg: false, xl: false } })
}))

let wrapper = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function mountNarrow(filters = []) {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'
  API_CLIENT.get.mockReturnValue({
    json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
  })
  const router = await createTestRouter(
    [{ path: '/_search', component: Search }, '/:pathMatch(.*)*'],
    '/_search?q=onboarding'
  )
  wrapper = mount(Search, {
    global: {
      plugins: [
        router,
        createTestI18n({ search: { filters: 'Filters', filtersActive: 'Filters ({count})' } })
      ],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  wrapper.vm.state.filters = filters
  await flushPromises()
  return wrapper
}

describe('Search.vue mobile Filters disclosure (OpenProject #3518)', () => {
  it('shows the plain label while no saved or added filter applies', async () => {
    const narrow = await mountNarrow()

    expect(narrow.find('[data-testid="search-filters-toggle"]').text()).toBe('Filters')
  })

  it('shows the active-filter count on the collapsed button so hidden filters are visible', async () => {
    const narrow = await mountNarrow([
      { id: 1, mode: 'exclude', type: 'path', value: 'private' },
      { id: 2, mode: 'include', type: 'locale', value: 'en' }
    ])

    const toggle = narrow.find('[data-testid="search-filters-toggle"]')
    expect(toggle.text()).toBe('Filters (2)')
    expect(toggle.attributes('aria-expanded')).toBe('false')
  })
})
