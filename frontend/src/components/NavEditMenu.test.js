import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import NavEditMenu from './NavEditMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'navEdit.title': 'Edit Navigation',
  'navEdit.editMenuItems': 'Edit Menu Items',
  'navEdit.saveModeSuccess': 'Navigation mode set successfully.',
  'navEdit.menuSourceLabel': 'Menu Source',
  'navEdit.menuSourceStatic': 'Manual',
  'navEdit.menuSourceStaticHint': 'Menu items are entered by hand below.',
  'navEdit.menuSourceAuto': 'Automatic',
  'navEdit.menuSourceAutoHint': 'Menu items are generated automatically.',
  'navEdit.menuSourceMixed': 'Mixed',
  'navEdit.menuSourceMixedHint': 'Generated items are combined with manual ones.',
  'navEdit.modeSectionLabel': 'Sidebar for this page',
  'navEdit.modeShow': 'Show',
  'navEdit.modeShowHint': 'Show the sidebar menu across the site.',
  'navEdit.modeHide': 'Hide',
  'navEdit.modeHideHint': 'Completely hide the sidebar menu.',
  'navEdit.modeInherit': 'Inherit',
  'navEdit.modeInheritHint': 'Use the menu and settings from the parent path.',
  'navEdit.modeOverride': 'Override, this page and below',
  'navEdit.modeOverrideHint': 'Set menu items and settings for this path and all descendants.',
  'navEdit.modeOverrideExact': 'Override, this page only',
  'navEdit.modeOverrideExactHint': 'Set menu items and settings only for this path.',
  'navEdit.modeHideDescendants': 'Hide, this page and below',
  'navEdit.modeHideDescendantsHint': 'No sidebar for this path and all descendants.',
  'navEdit.modeHideExact': 'Hide, this page only',
  'navEdit.modeHideExactHint': 'No sidebar only for this path.',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save'
}

const SERVER_ITEMS = [{ id: 'fresh', type: 'link', label: 'Fresh' }]

function mountMenu({ path = '', navigationId = 'nav-1', navigationMode = 'inherit' } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = path
  pageStore.navigationId = navigationId
  pageStore.navigationMode = navigationMode

  API_CLIENT.get.mockImplementation((url) => {
    if (url === `sites/site-1/navigation/${navigationId}/mode`) {
      return { json: vi.fn().mockResolvedValue({ mode: 'auto' }) }
    }
    if (url === 'sites/site-1/navigation/pages/page-1/inherited') {
      return { json: vi.fn().mockResolvedValue({ navigationId: 'ancestor-nav' }) }
    }
    // -> The sidebar's own re-fetch, once `save()` force-refreshes it -- any `.../navigation/<id>`
    //    not already matched above. Wrapped in the `{ mode, items }` envelope the real endpoint
    //    returns; `fetchNavigation()` (`stores/site.js`) destructures it, not a bare array.
    if (url.startsWith('sites/site-1/navigation/')) {
      return { json: vi.fn().mockResolvedValue({ mode: 'static', items: SERVER_ITEMS }) }
    }
    return { json: vi.fn().mockResolvedValue({}) }
  })

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(NavEditMenu, {
    global: { plugins: [i18n] }
  })

  return { wrapper, siteStore, pageStore }
}

describe('NavEditMenu', () => {
  it("loads the resolved menu's source mode on mount and saves it alongside the cascade mode", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1/mode')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'inherit', menuMode: 'auto' }
    })
  })

  it('skips loading a source mode when there is no resolved menu (sidebar hidden)', async () => {
    mountMenu({ navigationId: null })
    await flushPromises()

    expect(API_CLIENT.get).not.toHaveBeenCalledWith(expect.stringContaining('/mode'))
  })

  /**
   * OpenProject #1012's fix landed on `NavEditOverlay.vue`'s own Save button, but this popup's own
   * Save (which persists `mode`/`menuMode` directly, without ever opening the item editor) never
   * got the same force-refetch -- so a `menuMode` change (or an `override` <-> `overrideExact`
   * toggle) that resolves to the SAME `navigationId` left the sidebar showing stale items until a
   * full reload, since `NavSidebar.vue`'s `pageStore.navigationId` watcher only fires on an actual
   * id change and `fetchNavigation()`'s own cache gate would skip an unchanged id regardless.
   */
  it('force-refetches the sidebar nav on save, even when the resolved id is unchanged', async () => {
    const { wrapper, siteStore } = mountMenu()
    await flushPromises()

    siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    // -> The default `API_CLIENT.get` mock resolves `SERVER_ITEMS` for any `.../navigation/<id>` --
    //    no longer `stale` is the proof the gate was bypassed, not just that some request went out.
    await vi.waitUntil(() => siteStore.nav.items[0]?.id === 'fresh')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual(SERVER_ITEMS)
  })

  it('passes the loaded menuMode through to the item editor via overlayOpts on "Edit Menu Items"', async () => {
    const { wrapper, siteStore } = mountMenu()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('Edit Menu Items'))
    await editBtn.trigger('click')

    expect(siteStore.overlay).toBe('NavEdit')
    expect(siteStore.overlayOpts.menuMode).toBe('auto')
    expect(siteStore.overlayOpts.mode).toBe('inherit')
  })

  /**
   * Ledger restyle (Task #2799): the five non-root cascade rows render as radios sharing one
   * `v-model`, with a `NavCascadeGlyph` per row -- not the three-radio "Menu Source" list the
   * pre-restyle markup also used, which is a `w-btn-toggle` segmented control now (below).
   */
  it('renders one radio per non-root cascade mode, off the root', async () => {
    const { wrapper } = mountMenu({ path: 'docs/ingest' })
    await flushPromises()

    const radios = wrapper.findAll('[role="radio"]').filter((r) => r.attributes('aria-label'))
    // -> Five cascade radios plus the three Menu Source segments (also role="radio", part of
    //    `w-btn-toggle`'s own `radiogroup`) -- filtered down to the cascade group by their labels.
    const cascadeLabels = radios.map((r) => r.attributes('aria-label'))
    expect(cascadeLabels).toEqual([
      'Inherit',
      'Override, this page and below',
      'Override, this page only',
      'Hide, this page and below',
      'Hide, this page only'
    ])
  })

  it('renders only Show/Hide at the root, not the five descendant-cascade rows', async () => {
    const { wrapper } = mountMenu({ path: '' })
    await flushPromises()

    const radios = wrapper.findAll('[role="radio"]').filter((r) => r.attributes('aria-label'))
    const cascadeLabels = radios.map((r) => r.attributes('aria-label'))
    expect(cascadeLabels).toEqual(['Show', 'Hide'])
  })

  it('saves the mode picked by clicking a cascade row, not just the mounted default', async () => {
    const { wrapper } = mountMenu({ path: 'docs/ingest', navigationMode: 'inherit' })
    await flushPromises()

    const overrideRadio = wrapper
      .findAll('[role="radio"]')
      .find((r) => r.attributes('aria-label') === 'Override, this page and below')
    await overrideRadio.trigger('click')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'override', navigationId: 'nav-1' })
    })
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'override', menuMode: 'auto' }
    })
  })

  /**
   * Ledger restyle: "Menu Source" is a `w-btn-toggle` segmented control now, not three radios --
   * still driving the same `state.menuMode` the popup already saved (`menuMode` in the PUT body).
   */
  it('saves the menu source picked from the segmented control', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const autoSegment = wrapper
      .findAll('button[role="radio"]')
      .find((b) => b.text() === 'Automatic')
    expect(autoSegment).toBeTruthy()
    // -> Already `auto` from `loadMenuMode`'s own mocked response -- switch to Manual instead, so
    //    the assertion below proves the control's own click is what drives `state.menuMode`.
    const manualSegment = wrapper.findAll('button[role="radio"]').find((b) => b.text() === 'Manual')
    await manualSegment.trigger('click')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'inherit', menuMode: 'static' }
    })
  })

  it('hides the menu source control and Edit Menu Items button when canEditMenuItems is false', async () => {
    const { wrapper } = mountMenu({ navigationId: null, navigationMode: 'hide' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('Menu Source')
    expect(wrapper.findAll('button').find((b) => b.text().includes('Edit Menu Items'))).toBeFalsy()
  })

  /**
   * Cobalt restyle (Task #2800): the Save button's fill is `color="slate"`, resolved as an inline
   * style `WBtn` sets itself -- the only way `body.body--cobalt`'s own CSS can override it to the
   * handoff's distinct Cobalt slate-button tone is a class-scoped `!important` rule, so this class
   * is the one stable anchor that override needs. Not a color/style assertion (jsdom doesn't resolve
   * the aesthetic's `var()` cascade reliably) -- just proof the anchor survives future edits.
   */
  it("keeps the Save button's Cobalt-override class anchor", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    expect(saveBtn.classes()).toContain('nav-edit-menu__save-btn')
  })
})
