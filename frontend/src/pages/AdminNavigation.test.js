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
 * Dispatches `API_CLIENT.get` by URL, the way `AdminGeneral.test.js`'s `mountPage` does -- needed
 * here (unlike the sequential `mockReturnValueOnce` chain this file used before OpenProject #948)
 * because `onMounted` now fires TWO independent GETs (`load()`'s own `navigation/overrides`, and the
 * new `loadSiteLocales()`'s `sites/:id?strict=true`), and a `mockReturnValueOnce` queue is FIFO
 * across every call regardless of URL, not per-endpoint -- whichever of the two async functions
 * happens to reach its `await` first would silently consume the other's mock.
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
    Deliberately NOT the administered site's own locales -- `siteStore` is the site currently
    serving this browser tab, which the admin can be looking at a DIFFERENT site's screen from
    (OpenProject #948). Left with a distinct locale list from `SITE_LOCALES` below specifically so a
    test that accidentally read from here instead of `state.siteLocales` would fail loudly rather
    than happening to match by coincidence.
  */
  const siteStore = useSiteStore()
  siteStore.locales.active = [{ code: 'de', language: 'de', name: 'German', nativeName: 'Deutsch' }]

  mockApiClient(apiClient)

  // -> useSiteAdminAccess('site:navigation') needs a real route (for its `siteid` param) and a
  //    permission that satisfies GLOBAL_FALLBACKS['site:navigation'], so this mount neither warns
  //    on a missing router injection nor redirects away mid-test.
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

    // -> 'fr' matches the second row's locale but not either row's path -- a path-only filter
    //    must drop both, not match on the locale column the way w-table's own :filter prop would.
    const search = wrapper.find('input[type="text"]')
    await search.setValue('fr')

    expect(wrapper.findAll('.w-table__row').length).toBe(0)
    expect(wrapper.text()).toContain('No overrides match your search.')
  })

  it('re-fetches with the selected locale as a query param', async () => {
    const { wrapper } = await mountPage()
    // -> Two independent GETs settle on mount: `load()`'s own `navigation/overrides`, and
    //    `loadSiteLocales()`'s `sites/:id?strict=true` (OpenProject #948).
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length === 2)

    // -> Drives the locale select through its public v-model contract rather than reaching into
    //    AdminNavigation's internals, which `<script setup>` does not expose.
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
    // -> `w-btn` renders its label as text rather than `aria-label` when one is given -- find it by
    //    its visible text instead of assuming which attribute landed on the DOM button
    const btn = wrapper.findAll('button').find((b) => b.text().includes('Edit Default Menu'))
    await btn.trigger('click')
    await vi.waitUntil(() => dialog.mock.calls.length === 1)

    // -> No locale is selected (the "All Locales" filter), so it falls back to the site's primary
    //    locale rather than assuming its row id is the site id
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
    dialog.mockClear()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    const { wrapper } = await mountPage()
    await vi.waitUntil(() => wrapper.findAll('.w-table__row').length === OVERRIDES.length)

    // -> The second row (hide) has no navigationId -- nothing to edit -- so it falls back to opening
    //    the page, as before this task
    await wrapper.findAll('.w-table__row')[1].find('td').trigger('click')

    expect(openSpy).toHaveBeenCalledWith('/private', '_blank', 'noopener')
    expect(dialog).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  /**
   * WP #2577: the path-display case-style setting, embedded as its own card-local save (per
   * `docs/decisions/embedded-setting-save-affordance.md`) rather than a page-header Apply.
   */
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

/**
 * OpenProject #948: this screen watched only `state.locale`, unlike every sibling site-scoped admin
 * page (`AdminGeneral.vue`, `AdminApprovals.vue`, `AdminPagesDeleted.vue`, `AdminLocale.vue`), all of
 * which also watch `adminStore.currentSiteId` and refetch -- switching sites with the sidebar picker
 * while on this screen left the overrides table showing the previous site's rows. Secondary:
 * `localeOptions` read `siteStore.locales.active` (the site serving the browser) rather than the
 * administered site's own locales, offering the wrong filter list whenever the two sites differ.
 */
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
    // -> `mountPage()` seeds `siteStore.locales.active` with German only, and the fixture's own
    //    `sites/site-1?strict=true` mock (`SITE_LOCALES`) with English/French -- proving which one
    //    the dropdown actually read from.
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
