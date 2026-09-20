import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminNavigation from './AdminNavigation.vue'
import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { dialog } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { stubApi } from '../../test/mocks.js'

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
  'admin.navigation.modeLabelHideExact': 'Hide Current Only',
  'admin.navigation.pathDisplayTitle': 'Path Display',
  'admin.navigation.pathDisplaySubtitle':
    'Choose how lowercase page and folder paths are cased when shown to readers.',
  'admin.navigation.pathDisplayLabel': 'Case Style',
  'admin.navigation.pathDisplayCaseOff': 'Off (show path as-is)',
  'admin.navigation.pathDisplayCaseLower': 'all lowercase',
  'admin.navigation.pathDisplayCaseUpper': 'ALL UPPERCASE',
  'admin.navigation.pathDisplayCaseCamel': 'camelCase',
  'admin.navigation.pathDisplayCasePascal': 'PascalCase',
  'admin.navigation.pathDisplayCaseTitle': 'Title Case',
  'admin.navigation.pathDisplaySaveSuccess': 'Path display setting saved.',
  'admin.navigation.pathDisplaySaveFailed': 'Failed to save the path display setting.',
  'common.actions.save': 'Save'
}

const SITE_LOCALES = [
  { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
]

/**
 * Dispatches `API_CLIENT.get` by URL rather than by call order: `onMounted` fires two independent
 * GETs, and a `mockReturnValueOnce` queue is FIFO across every call regardless of URL, so whichever
 * of the two reached its `await` first would silently consume the other's mock.
 */
function mockApiClient({
  overrides = OVERRIDES,
  siteLocales = SITE_LOCALES,
  primary = 'en',
  pathDisplayCase
} = {}) {
  stubApi({
    'sites/site-1/navigation/overrides': overrides,
    'sites/site-1?strict=true': {
      locales: { active: siteLocales, primary },
      ...(pathDisplayCase !== undefined && { pathDisplayCase })
    }
  })
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

async function mountPage({ apiClient = {} } = {}) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  /*
    `siteStore` is the site serving this browser tab, which can differ from the one being
    administered. Given a locale list disjoint from `SITE_LOCALES` on purpose, so a test that reads
    the wrong one fails loudly instead of matching by coincidence.
  */
  const siteStore = useSiteStore()
  siteStore.locales.active = [{ code: 'de', language: 'de', name: 'German', nativeName: 'Deutsch' }]

  mockApiClient(apiClient)

  // -> `useSiteAdminAccess('site:navigation')` needs a real route (for its `siteid` param) and a
  //    permission that satisfies it, or the mount redirects away mid-test
  const userStore = useUserStore()
  userStore.permissions = ['manage:navigation']

  const router = await createTestRouter(['/_admin/:siteid/navigation'], '/_admin/site-1/navigation')

  const i18n = createTestI18n(MESSAGES)

  const wrapper = mount(AdminNavigation, {
    global: {
      plugins: [router, i18n]
    }
  })

  return { wrapper, adminStore }
}

describe('AdminNavigation', () => {
  it('loads overrides for the current admin site and renders path, locale and mode per row', async () => {
    const { wrapper } = await mountPage()
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

  it('shows the empty-source message, not the no-match one, when there are no overrides at all (OpenProject #2061)', async () => {
    const { wrapper } = await mountPage({ apiClient: { overrides: [] } })
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === 0)
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('No pages or folders override the default navigation yet.')
    expect(wrapper.text()).not.toContain('No overrides match your search.')
  })

  it('filters rows by path only, not by locale or mode', async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> 'fr' matches the second row's locale but neither row's path, so a path-only filter drops
    //    both where `w-table`'s own `:filter` prop would keep one
    const search = wrapper.find('input[type="text"]')
    await search.setValue('fr')

    expect(wrapper.findAll('.w-table__row').length).toBe(0)
    expect(wrapper.text()).toContain('No overrides match your search.')
  })

  it('re-fetches with the selected locale as a query param', async () => {
    const { wrapper } = await mountPage()
    // -> Two independent GETs settle on mount: the overrides table and the site's own locales
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    // -> `<script setup>` exposes no internals, so the select is driven through its v-model
    const localeSelect = wrapper.findComponent({ name: 'WSelect' })
    await localeSelect.vm.$emit('update:modelValue', 'fr')
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 3)

    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/navigation/overrides', {
      searchParams: { locale: 'fr' }
    })
  })

  it('opens the site-wide default menu directly, resolving its locale-scoped row id first', async () => {
    dialog.mockClear()

    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> Consumed by `openDefaultMenu()`'s own single GET, the only one pending at this point
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ navigationId: 'default-nav-en' })
    })
    // -> `w-btn` renders a label as text, not as `aria-label`, so the button is found by its text
    const btn = wrapper.findAll('button').find((b) => b.text().includes('Edit Default Menu'))
    await btn.trigger('click')
    await vi.waitUntil(() => dialog.mock.calls.length === 1)

    // -> No locale picked ("All Locales"), so it resolves against the site's primary locale
    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/navigation/default', {
      searchParams: { locale: 'en' }
    })
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({
          siteId: 'site-1',
          navId: 'default-nav-en',
          title: 'Site Default Menu'
        })
      })
    )
  })

  it('renders the "Edit Default Menu" button in the standard accent color, not the deep-orange-9 red-tint (OpenProject #3108)', async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    const editBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((btn) => btn.text().includes('Edit Default Menu'))
    expect(editBtn.exists()).toBe(true)
    expect(editBtn.props('color')).toBe('accent')
    expect(editBtn.props('color')).not.toBe('deep-orange-9')
  })

  it('resolves the default menu for whichever locale is currently selected', async () => {
    dialog.mockClear()

    const { wrapper } = await mountPage()
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    const localeSelect = wrapper.findComponent({ name: 'WSelect' })
    await localeSelect.vm.$emit('update:modelValue', 'fr')
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 3)

    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ navigationId: 'default-nav-fr' })
    })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('Edit Default Menu'))
    await btn.trigger('click')
    await vi.waitUntil(() => dialog.mock.calls.length === 1)

    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/navigation/default', {
      searchParams: { locale: 'fr' }
    })
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({ navId: 'default-nav-fr' })
      })
    )
  })

  it('opens the shared editor for an override row that has its own menu items', async () => {
    dialog.mockClear()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

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
    dialog.mockClear()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    await wrapper.findAll('.w-table__row')[1].find('td').trigger('click')

    expect(openSpy).toHaveBeenCalledWith('/private', '_blank', 'noopener')
    expect(dialog).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it("defaults the path display picker to 'off' when the site has no pathDisplayCase set yet", async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.pathDisplayCase).toBe('off')
  })

  it("loads the administered site's own stored pathDisplayCase", async () => {
    const { wrapper } = await mountPage({ apiClient: { pathDisplayCase: 'title' } })
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.pathDisplayCase).toBe('title')
  })

  it('saves the path display case style through the dedicated pathDisplay route, not PUT /:siteId', async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, message: 'Path display setting updated.' })
    })

    wrapper.vm.state.pathDisplayCase = 'pascal'
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === 'Save')
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length === 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pathDisplay', {
      json: { caseStyle: 'pascal' }
    })
  })

  it('shows a failure toast, and clears the loading flag, when saving the path display setting fails', async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    API_CLIENT.put.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text() === 'Save')
    await saveBtn.trigger('click')
    await vi.waitUntil(() => wrapper.vm.state.savingPathDisplay === false)

    expect(wrapper.vm.state.savingPathDisplay).toBe(false)
  })
})

describe('AdminNavigation site-switch reload (OpenProject #948)', () => {
  it('re-fetches the overrides table when adminStore.currentSiteId changes', async () => {
    const { wrapper, adminStore } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)
    API_CLIENT.get.mockClear()

    const OTHER_SITE_OVERRIDES = [
      {
        id: '9',
        type: 'page',
        folderPath: '',
        fileName: 'other-site-page',
        title: 'Other Site Page',
        locale: 'en',
        navigationMode: 'override',
        navigationId: 'nav-9'
      }
    ]
    stubApi({
      'sites/site-2/navigation/overrides': OTHER_SITE_OVERRIDES,
      'sites/site-2?strict=true': { locales: { active: SITE_LOCALES, primary: 'en' } }
    })

    adminStore.currentSiteId = 'site-2'
    await vi.waitUntil(() =>
      API_CLIENT.get.mock.calls.some(([url]) => url === 'sites/site-2/navigation/overrides')
    )
    await vi.waitUntil(() => wrapper.text().includes('other-site-page'))

    expect(wrapper.text()).not.toContain('docs/getting-started')
    expect(wrapper.text()).toContain('other-site-page')
  })

  it('resolves "Edit Default Menu" against the NEW site once the admin has switched sites', async () => {
    dialog.mockClear()
    const { wrapper, adminStore } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    stubApi({
      'sites/site-2/navigation/overrides': [],
      'sites/site-2?strict=true': { locales: { active: SITE_LOCALES, primary: 'en' } },
      'sites/site-2/navigation/default': { navigationId: 'default-nav-site-2' }
    })
    adminStore.currentSiteId = 'site-2'
    await vi.waitUntil(() =>
      API_CLIENT.get.mock.calls.some(([url]) => url === 'sites/site-2/navigation/overrides')
    )

    const btn = wrapper.findAll('button').find((b) => b.text().includes('Edit Default Menu'))
    await btn.trigger('click')
    await vi.waitUntil(() => dialog.mock.calls.length === 1)

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({ siteId: 'site-2', navId: 'default-nav-site-2' })
      })
    )
  })

  it("sources the locale filter's options from the administered site, not the browser's serving site", async () => {
    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)
    // -> German comes only from `siteStore`, English/French only from the administered site's
    //    fixture, so the option codes name which one the dropdown read
    await vi.waitUntil(() =>
      API_CLIENT.get.mock.calls.some(([url]) => url === 'sites/site-1?strict=true')
    )
    await wrapper.vm.$nextTick()

    const localeSelect = wrapper.findComponent({ name: 'WSelect' })
    const optionCodes = localeSelect.props('options').map((o) => o.code)

    expect(optionCodes).toEqual([null, 'en', 'fr'])
    expect(optionCodes).not.toContain('de')
  })
})
