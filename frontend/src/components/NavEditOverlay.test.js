import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import NavEditOverlay from './NavEditOverlay.vue'
import NavItemEditor from './NavItemEditor.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'navEdit.editMenuItems': 'Edit Menu Items',
  'navEdit.editingInherited': 'Inherited menu',
  'navEdit.menuSourceReadOnlyNotice': 'This menu is generated automatically from the page tree.',
  'navEdit.saveSuccess': 'Menu items saved successfully.',
  'navEdit.emptyMenuText': 'Click the Add button to add your first menu item.',
  'navEdit.noSelection': 'Select a menu item from the left to start editing.',
  'navEdit.header': 'Header',
  'navEdit.link': 'Link',
  'navEdit.separator': 'Separator',
  'navEdit.clearItems': 'Clear All Items',
  'navEdit.visibilityAll': 'Everyone',
  'navEdit.visibilityLimited': 'Selected Groups',
  'common.actions.viewDocs': 'View Docs',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save',
  'common.actions.add': 'Add'
}

const SERVER_ITEMS = [
  { id: 'link-1', type: 'link', label: 'Home', icon: 'mdi:home', target: '/', visibilityGroups: [] }
]

function mountOverlay({ isHome = false, navId = null, mode = null, menuMode = null } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.overlayOpts = {
    ...(navId && { navId }),
    ...(mode && { mode }),
    ...(menuMode && { menuMode })
  }

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = isHome ? '' : 'some-page'
  pageStore.navigationId = 'inherited-nav-1'
  pageStore.navigationMode = 'inherit'

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue([]) }
    }
    return { json: vi.fn().mockResolvedValue(SERVER_ITEMS) }
  })

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(NavEditOverlay, {
    global: { plugins: [i18n] }
  })

  return { wrapper, siteStore, pageStore }
}

describe('NavEditOverlay', () => {
  it("resolves navId to the page's own id, and PUTs pages/:pageId with mode + items on save", async () => {
    const { wrapper, siteStore, pageStore } = mountOverlay()
    // -> Settles both the item and group fetches (and the reactive update that re-enables the Save
    //    button once the editor's own `loading` count drops back to 0), not just their issuing
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/page-1', {
      searchParams: { full: true }
    })

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-x' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: {
        mode: 'inherit',
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
    // -> Refreshes both stores from what the save actually resolved to, exactly as before extraction
    expect(pageStore.navigationMode).toBe('inherit')
    expect(pageStore.navigationId).toBe('nav-x')
  })

  it('resolves navId from overlayOpts.navId for an inherited menu, and closes the overlay on save', async () => {
    const { wrapper, siteStore } = mountOverlay({ navId: 'inherited-nav-1', mode: 'inherit' })
    // -> Settles both the item and group fetches (and the reactive update that re-enables the Save
    //    button once the editor's own `loading` count drops back to 0), not just their issuing
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/inherited-nav-1', {
      searchParams: { full: true }
    })
    expect(wrapper.text()).toContain('Inherited menu')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-x' })
    })
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => siteStore.overlay === '')

    expect(API_CLIENT.put.mock.calls[0][1].json.mode).toBe('inherit')
  })

  it('threads overlayOpts.menuMode through to nav-item-editor and back out on save', async () => {
    const { wrapper } = mountOverlay({ menuMode: 'mixed' })
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-x' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put.mock.calls[0][1].json.menuMode).toBe('mixed')
  })

  it('shows a read-only notice and disables Save while the resolved menu is auto', async () => {
    const { wrapper } = mountOverlay({ menuMode: 'auto' })
    await flushPromises()

    expect(wrapper.text()).toContain('This menu is generated automatically from the page tree.')
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    expect(saveBtn.attributes('disabled')).not.toBeUndefined()
  })

  /**
   * OpenProject #1012: the reader-facing sidebar (`NavSidebar.vue`) must reflect this save in the
   * same tab without a reload, even when the save resolves to an id the store already has cached --
   * exactly the "already showing this menu" case `fetchNavigation()`'s own gate exists for, which is
   * why this save must force past it.
   */
  it('force-refetches the sidebar nav on save, even though the resolved id is already cached', async () => {
    const { wrapper, siteStore } = mountOverlay()
    await flushPromises()

    siteStore.$patch({ nav: { currentId: 'nav-x', items: [{ id: 'stale' }] } })

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-x' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => siteStore.overlay === '')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-x')
    // -> The default `API_CLIENT.get` mock resolves `SERVER_ITEMS` for any id -- no longer `stale`
    //    is the proof the gate was bypassed, not just that some request went out.
    expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
  })

  /**
   * `nav-item-editor`'s "Copy from..." action persists immediately, ahead of this overlay's own Save
   * button (see `NavItemEditor.vue`'s `copied` event doc comment) -- so the sidebar has to be
   * invalidated from that event too, not only from `save()`.
   */
  it("force-refetches the sidebar nav when nav-item-editor emits 'copied'", async () => {
    const { wrapper, siteStore } = mountOverlay({ navId: 'inherited-nav-1', mode: 'inherit' })
    await flushPromises()

    siteStore.$patch({ nav: { currentId: 'inherited-nav-1', items: [{ id: 'stale' }] } })

    await wrapper.findComponent(NavItemEditor).vm.$emit('copied')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/inherited-nav-1')
    expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
  })
})
