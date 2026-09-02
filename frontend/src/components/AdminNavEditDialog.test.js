import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminNavEditDialog from './AdminNavEditDialog.vue'
import NavItemEditor from './NavItemEditor.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'navEdit.editMenuItems': 'Edit Menu Items',
  'navEdit.saveSuccess': 'Menu items saved successfully.',
  'navEdit.emptyMenuText': 'Click the Add button to add your first menu item.',
  'navEdit.noSelection': 'Select a menu item from the left to start editing.',
  'common.actions.viewDocs': 'View Docs',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save'
}

const SERVER_ITEMS = [
  { id: 'link-1', type: 'link', label: 'Home', icon: 'mdi:home', target: '/', visibilityGroups: [] }
]

/**
 * `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick after
 * mount (see `composables/dialog.js`) -- `<w-dialog>` also teleports its panel via
 * `<teleport to="body">`, which `stubs: { teleport: true }` keeps in place so `wrapper.find()` can
 * still reach it, matching `BlockUploadDialog.test.js`'s own mounting pattern.
 */
function mountDialog({
  siteId = 'site-2',
  navId = 'nav-1',
  activeSiteId = 'site-1',
  currentNavigationId = null
} = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = activeSiteId

  const pageStore = usePageStore()
  pageStore.navigationId = currentNavigationId

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue([]) }
    }
    return { json: vi.fn().mockResolvedValue(SERVER_ITEMS) }
  })

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(AdminNavEditDialog, {
    props: { siteId, navId },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })

  return { wrapper, siteStore, pageStore }
}

describe('AdminNavEditDialog', () => {
  it('saves straight to PUT sites/:siteId/navigation/:navId, mode-agnostically', async () => {
    const { wrapper } = mountDialog({ siteId: 'site-2', navId: 'nav-1' })
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-2/navigation/nav-1', {
      json: {
        items: [
          {
            id: 'link-1',
            type: 'link',
            label: 'Home',
            icon: 'mdi:home',
            target: '/',
            openInNewWindow: undefined,
            visibilityGroups: [],
            children: [],
            expandByDefault: false
          }
        ]
      }
    })
  })

  /**
   * OpenProject #1012: this dialog has no page context of its own -- unlike `NavEditOverlay.vue` --
   * so it force-refetches whatever menu the tab's OWN current page shows (`pageStore.navigationId`),
   * not `props.navId`, and only when the site being administered (`props.siteId`, resolved from
   * `adminStore.currentSiteId`) is actually the one loaded in this tab (`siteStore.id`). See
   * `invalidateSidebarNav()`'s own doc comment for why.
   */
  describe('same-tab sidebar invalidation (OpenProject #1012)', () => {
    it('force-refetches the sidebar nav on save when administering the site actually active in this tab', async () => {
      const { wrapper, siteStore } = mountDialog({
        siteId: 'site-1',
        navId: 'nav-1',
        activeSiteId: 'site-1',
        currentNavigationId: 'nav-x'
      })
      await flushPromises()

      // -> Already cached (stale) under this id -- the plain "id changed" gate `fetchNavigation()`
      //    applies would otherwise skip a refetch here.
      siteStore.$patch({ nav: { currentId: 'nav-x', items: [{ id: 'stale' }] } })

      API_CLIENT.put.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ ok: true })
      })

      const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
      await saveBtn.trigger('click')
      await vi.waitUntil(() => wrapper.emitted('ok'))

      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-x')
      expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
    })

    it('does not touch the sidebar nav when administering a DIFFERENT site than the one loaded in this tab', async () => {
      const { wrapper, siteStore } = mountDialog({
        siteId: 'site-2',
        navId: 'nav-1',
        activeSiteId: 'site-1',
        currentNavigationId: 'nav-x'
      })
      await flushPromises()

      siteStore.$patch({ nav: { currentId: 'nav-x', items: [{ id: 'stale' }] } })
      API_CLIENT.get.mockClear()

      API_CLIENT.put.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ ok: true })
      })

      const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
      await saveBtn.trigger('click')
      await vi.waitUntil(() => wrapper.emitted('ok'))

      expect(API_CLIENT.get).not.toHaveBeenCalled()
      expect(siteStore.nav.items).toEqual([{ id: 'stale' }])
    })

    it("also force-refetches the sidebar nav when nav-item-editor emits 'copied'", async () => {
      const { wrapper, siteStore } = mountDialog({
        siteId: 'site-1',
        navId: 'nav-1',
        activeSiteId: 'site-1',
        currentNavigationId: 'nav-1'
      })
      await flushPromises()

      siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

      await wrapper.findComponent(NavItemEditor).vm.$emit('copied')
      await flushPromises()

      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
      expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
    })
  })
})
