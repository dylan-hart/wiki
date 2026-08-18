import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminNavigation from './AdminNavigation.vue'
import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { dialog } from '@/composables/dialog'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))

const MESSAGES = {
  'admin.navigation.title': 'Navigation',
  'admin.navigation.subtitle': 'Find pages and folders that override the default navigation menu',
  'admin.navigation.columnPath': 'Path',
  'admin.navigation.columnLocale': 'Locale',
  'admin.navigation.columnMode': 'Mode',
  'admin.navigation.searchPlaceholder': 'Search path...',
  'admin.navigation.localeFilterLabel': 'Locale',
  'admin.navigation.allLocales': 'All Locales',
  'admin.navigation.editDefaultMenu': 'Edit Default Menu',
  'admin.navigation.defaultMenuTitle': 'Site Default Menu',
  'admin.navigation.emptyText': 'No pages or folders override the default navigation yet.',
  'admin.navigation.noMatchesText': 'No overrides match your search.',
  'admin.navigation.loadFailed': 'Failed to load navigation overrides.',
  'admin.navigation.modeLabelInherit': 'Inherit',
  'admin.navigation.modeLabelOverride': 'Override Current + Descendants',
  'admin.navigation.modeLabelOverrideExact': 'Override Current Only',
  'admin.navigation.modeLabelHide': 'Hide Current + Descendants',
  'admin.navigation.modeLabelHideExact': 'Hide Current Only'
}

const OVERRIDES = [
  {
    id: '1',
    type: 'page',
    folderPath: 'docs',
    fileName: 'getting-started',
    title: 'Getting Started',
    locale: 'en',
    navigationMode: 'overrideExact',
    navigationId: 'nav-1'
  },
  {
    id: '2',
    type: 'folder',
    folderPath: '',
    fileName: 'private',
    title: 'Private',
    locale: 'fr',
    navigationMode: 'hide',
    navigationId: null
  }
]

function mountPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const siteStore = useSiteStore()
  siteStore.locales.active = [
    { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
    { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
  ]

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })

  const wrapper = mount(AdminNavigation, {
    global: {
      plugins: [i18n]
    }
  })

  return { wrapper, adminStore }
}

describe('AdminNavigation', () => {
  it('loads overrides for the current admin site and renders path, locale and mode per row', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(OVERRIDES) })

    const { wrapper } = mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/navigation/overrides',
      expect.anything()
    )

    const text = wrapper.text()
    expect(text).toContain('docs/getting-started')
    expect(text).toContain('Override Current Only')
    expect(text).toContain('private')
    expect(text).toContain('Hide Current + Descendants')
  })

  it('filters rows by path only, not by locale or mode', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(OVERRIDES) })

    const { wrapper } = mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> 'fr' matches the second row's locale but not either row's path -- a path-only filter
    //    must drop both, not match on the locale column the way w-table's own :filter prop would.
    const search = wrapper.find('input[type="text"]')
    await search.setValue('fr')

    expect(wrapper.findAll('.w-table__row').length).toBe(0)
    expect(wrapper.text()).toContain('No overrides match your search.')
  })

  it('re-fetches with the selected locale as a query param', async () => {
    API_CLIENT.get.mockReturnValue({ json: vi.fn().mockResolvedValue(OVERRIDES) })

    const { wrapper } = mountPage()
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 1)

    // -> Drives the locale select through its public v-model contract rather than reaching into
    //    AdminNavigation's internals, which `<script setup>` does not expose.
    const localeSelect = wrapper.findComponent({ name: 'WSelect' })
    await localeSelect.vm.$emit('update:modelValue', 'fr')
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/navigation/overrides', {
      searchParams: { locale: 'fr' }
    })
  })

  it('opens the site-wide default menu directly, without a page to navigate to first', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(OVERRIDES) })
    dialog.mockClear()

    const { wrapper } = mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> `w-btn` renders its label as text rather than `aria-label` when one is given -- find it by
    //    its visible text instead of assuming which attribute landed on the DOM button
    const btn = wrapper.findAll('button').find((b) => b.text().includes('Edit Default Menu'))
    await btn.trigger('click')

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({
          siteId: 'site-1',
          navId: 'site-1',
          title: 'Site Default Menu'
        })
      })
    )
  })

  it('opens the shared editor for an override row that has its own menu items', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(OVERRIDES) })
    dialog.mockClear()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    const { wrapper } = mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> The first row (overrideExact) has a navigationId -- its own menu -- so it opens the editor
    //    rather than the page itself
    await wrapper.findAll('.w-table__row')[0].find('td').trigger('click')

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({
          siteId: 'site-1',
          navId: 'nav-1',
          title: '/docs/getting-started'
        })
      })
    )
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('still opens the page itself for a hide-mode row, which has no menu items to edit', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(OVERRIDES) })
    dialog.mockClear()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    const { wrapper } = mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> The second row (hide) has no navigationId -- nothing to edit -- so it falls back to opening
    //    the page, as before this task
    await wrapper.findAll('.w-table__row')[1].find('td').trigger('click')

    expect(openSpy).toHaveBeenCalledWith('/private', '_blank', 'noopener')
    expect(dialog).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })
})
