import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import NavItemEditor from './NavItemEditor.vue'
import { dialog } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))

/*
  `WMenu` (the kebab "more actions" menu) teleports its open content straight into `document.body`,
  independent of whichever wrapper mounted it -- and nothing here unmounts a wrapper between tests, so
  a menu left open by one test would otherwise still be sitting in `document.body` for the next one to
  find via a plain `.w-menu` query.
*/
afterEach(() => {
  document.body.innerHTML = ''
})

const MESSAGES = {
  'navEdit.header': 'Header',
  'navEdit.link': 'Link',
  'navEdit.separator': 'Separator',
  'navEdit.emptyMenuText': 'Click the Add button to add your first menu item.',
  'navEdit.noSelection': 'Select a menu item from the left to start editing.',
  'navEdit.visibilityAll': 'Everyone',
  'navEdit.visibilityLimited': 'Selected Groups',
  'navEdit.groupsFailed': 'Failed to load the list of groups.',
  'navEdit.menuSourceReadOnlyNotice': 'This menu is generated automatically from the page tree.',
  'navEdit.menuSourceMixedListHint': 'Dimmed items are generated automatically.',
  'common.actions.add': 'Add',
  'common.actions.delete': 'Delete',
  'navEdit.clearItems': 'Clear All Items',
  'navEdit.copyFrom': 'Copy from...',
  'navEdit.copyFromWarn': 'Menu items copied. Review the copied links.'
}

const SERVER_ITEMS = [
  {
    id: 'parent-1',
    type: 'link',
    label: 'Parent',
    icon: 'tabler:file-text',
    target: '/parent',
    openInNewWindow: false,
    expandByDefault: true,
    visibilityGroups: [],
    children: [
      {
        id: 'child-1',
        type: 'link',
        label: 'Child',
        icon: 'tabler:file-text',
        target: '/parent/child',
        openInNewWindow: false,
        visibilityGroups: ['group-1']
      }
    ]
  },
  {
    id: 'header-1',
    type: 'header',
    label: 'Section',
    visibilityGroups: []
  }
]

function mountEditor({ items = SERVER_ITEMS, groups = [], menuMode, roots = [], sites = [] } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue(groups) }
    }
    if (url === 'sites') {
      return { json: vi.fn().mockResolvedValue(sites) }
    }
    if (url === 'sites/site-1/navigation/roots') {
      return { json: vi.fn().mockResolvedValue(roots) }
    }
    return { json: vi.fn().mockResolvedValue({ mode: 'static', items }) }
  })

  const i18n = createTestI18n(MESSAGES)
  return mount(NavItemEditor, {
    props: { siteId: 'site-1', navId: 'nav-1', ...(menuMode && { menuMode }) },
    global: { plugins: [i18n] }
  })
}

/** Opens the kebab ("more actions") menu and returns its teleported panel. */
async function openKebabMenu(wrapper) {
  await wrapper.find('button.ms-2').trigger('click')
  await vi.waitUntil(() => document.querySelector('.w-menu'))
  return document.querySelector('.w-menu')
}

describe('NavItemEditor', () => {
  it("loads a menu's full items (including group-limited ones) and the group list on mount", async () => {
    const wrapper = mountEditor()
    await vi.waitUntil(() => !wrapper.vm.loading)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1', {
      searchParams: { full: true }
    })
    expect(API_CLIENT.get).toHaveBeenCalledWith('groups')
  })

  it('round-trips a loaded parent/child link pair through buildSaveItems unchanged', async () => {
    const wrapper = mountEditor()
    await vi.waitUntil(() => !wrapper.vm.loading)

    const saved = wrapper.vm.buildSaveItems()

    expect(saved).toEqual([
      {
        id: 'parent-1',
        type: 'link',
        label: 'Parent',
        icon: 'tabler:file-text',
        target: '/parent',
        openInNewWindow: false,
        expandByDefault: true,
        visibilityGroups: [],
        children: [
          {
            id: 'child-1',
            type: 'link',
            label: 'Child',
            icon: 'tabler:file-text',
            target: '/parent/child',
            openInNewWindow: false,
            visibilityGroups: ['group-1']
          }
        ]
      },
      {
        id: 'header-1',
        type: 'header',
        label: 'Section',
        visibilityGroups: []
      }
    ])
  })

  it("drops a header's visibilityGroups once limited visibility is turned back off in the UI", async () => {
    const wrapper = mountEditor({
      items: [{ id: 'h1', type: 'header', label: 'Section', visibilityGroups: ['group-1'] }]
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    // -> Loaded with a group already set, so `visibilityLimited` starts true -- select the item to
    //    make its panel (and the toggle) appear
    await wrapper.find('.nav-edit-item-header').trigger('click')
    const toggle = wrapper.findComponent({ name: 'WBtnToggle' })
    await toggle.vm.$emit('update:modelValue', false)

    const [item] = wrapper.vm.buildSaveItems()
    expect(item.visibilityGroups).toEqual([])
  })

  it("discovers copy sources (this site's locale roots and other enabled sites) on mount", async () => {
    const wrapper = mountEditor({
      roots: [{ locale: 'en', navigationId: 'nav-1' }],
      sites: [{ id: 'site-2', title: 'Other Site', hostname: 'other.example.com', isEnabled: true }]
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/roots')
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites')
  })

  it('hides the "Copy from..." action when the site has one locale and there is no other enabled site', async () => {
    const wrapper = mountEditor({
      roots: [{ locale: 'en', navigationId: 'nav-1' }],
      sites: []
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    const menu = await openKebabMenu(wrapper)
    expect(menu.textContent).not.toContain('Copy from...')
  })

  it('hides "Copy from..." when the only other site on the list is disabled', async () => {
    const wrapper = mountEditor({
      roots: [{ locale: 'en', navigationId: 'nav-1' }],
      sites: [
        { id: 'site-2', title: 'Disabled Site', hostname: 'off.example.com', isEnabled: false }
      ]
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    const menu = await openKebabMenu(wrapper)
    expect(menu.textContent).not.toContain('Copy from...')
  })

  it('shows "Copy from..." and opens the source picker with the discovered locales and sites', async () => {
    dialog.mockClear()
    const roots = [
      { locale: 'en', navigationId: 'nav-1' },
      { locale: 'fr', navigationId: 'nav-2' }
    ]
    const sites = [
      { id: 'site-2', title: 'Other Site', hostname: 'other.example.com', isEnabled: true }
    ]
    const wrapper = mountEditor({ roots, sites })
    await vi.waitUntil(() => !wrapper.vm.loading)

    const menu = await openKebabMenu(wrapper)
    const copyAction = [...menu.querySelectorAll('[role="button"]')].find((el) =>
      el.textContent.includes('Copy from...')
    )
    expect(copyAction).toBeTruthy()
    copyAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitUntil(() => dialog.mock.calls.length === 1)
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({
          siteId: 'site-1',
          navId: 'nav-1',
          locales: roots,
          otherSites: sites
        })
      })
    )
  })

  it("copies with mode 'append', reloads the items, and warns to review the copied links", async () => {
    let confirm
    dialog.mockImplementation(() => ({
      onOk: (cb) => {
        confirm = cb
      }
    }))
    const wrapper = mountEditor({
      roots: [
        { locale: 'en', navigationId: 'nav-1' },
        { locale: 'fr', navigationId: 'nav-2' }
      ],
      sites: []
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    const menu = await openKebabMenu(wrapper)
    const copyAction = [...menu.querySelectorAll('[role="button"]')].find((el) =>
      el.textContent.includes('Copy from...')
    )
    copyAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitUntil(() => typeof confirm === 'function')

    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })
    API_CLIENT.get.mockClear()
    const getCalls = API_CLIENT.get.mock.calls.length

    await confirm({ sourceSiteId: 'site-1', sourceNavId: 'nav-2' })

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/navigation/nav-1/copy', {
      json: { sourceSiteId: 'site-1', sourceNavId: 'nav-2', mode: 'append' }
    })
    // -> Reloads the menu's items from the server rather than assuming the merge locally
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1', {
      searchParams: { full: true }
    })
    expect(API_CLIENT.get.mock.calls.length).toBeGreaterThan(getCalls)
    expect(wrapper.vm.loading).toBe(false)
  })

  it('surfaces the API error and leaves the menu untouched when the copy is refused', async () => {
    let confirm
    dialog.mockImplementation(() => ({
      onOk: (cb) => {
        confirm = cb
      }
    }))
    const wrapper = mountEditor({
      roots: [
        { locale: 'en', navigationId: 'nav-1' },
        { locale: 'fr', navigationId: 'nav-2' }
      ],
      sites: []
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    const menu = await openKebabMenu(wrapper)
    const copyAction = [...menu.querySelectorAll('[role="button"]')].find((el) =>
      el.textContent.includes('Copy from...')
    )
    copyAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitUntil(() => typeof confirm === 'function')

    const err = new Error('Bad Request')
    err.data = { message: 'Nope.' }
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockRejectedValue(err)
    })
    const itemsBefore = wrapper.vm.buildSaveItems()

    await confirm({ sourceSiteId: 'site-1', sourceNavId: 'nav-2' })

    expect(wrapper.vm.buildSaveItems()).toEqual(itemsBefore)
  })

  it('emits load-error and notifies when the initial fetch fails', async () => {
    API_CLIENT.get.mockImplementation(() => {
      throw new Error('network down')
    })
    const i18n = createTestI18n(MESSAGES)
    const wrapper = mount(NavItemEditor, {
      props: { siteId: 'site-1', navId: 'nav-1' },
      global: { plugins: [i18n] }
    })
    await vi.waitUntil(() => !wrapper.vm.loading)

    expect(wrapper.emitted('load-error')).toBeTruthy()
  })

  describe('menuMode: auto', () => {
    const GENERATED_ITEMS = [
      {
        id: 'gen-1',
        type: 'link',
        label: 'Generated Page',
        target: '/en/generated-page',
        generated: true
      }
    ]

    it('hides the Add control and buildSaveItems drops every (generated) item', async () => {
      const wrapper = mountEditor({ items: GENERATED_ITEMS, menuMode: 'auto' })
      await vi.waitUntil(() => !wrapper.vm.loading)

      expect(wrapper.findAll('button').some((b) => b.text().includes('Add'))).toBe(false)
      expect(wrapper.vm.buildSaveItems()).toEqual([])
    })

    it('shows a read-only notice and disables the Delete button once a generated item is selected', async () => {
      const wrapper = mountEditor({ items: GENERATED_ITEMS, menuMode: 'auto' })
      await vi.waitUntil(() => !wrapper.vm.loading)

      await wrapper.find('.nav-edit-item-link').trigger('click')

      expect(wrapper.text()).toContain('This menu is generated automatically from the page tree.')
      expect(wrapper.findAll('button').some((b) => b.text().includes('Delete'))).toBe(false)
    })
  })

  describe('menuMode: mixed', () => {
    const MIXED_ITEMS = [
      {
        id: 'pinned-before',
        type: 'link',
        label: 'Pinned Before',
        target: '/',
        visibilityGroups: []
      },
      {
        id: 'gen-1',
        type: 'link',
        label: 'Generated',
        target: '/en/generated',
        visibilityGroups: [],
        generated: true
      },
      { id: 'stored-after', type: 'link', label: 'Stored After', target: '/', visibilityGroups: [] }
    ]

    it('buildSaveItems drops generated items and pins the surviving stored ones by position', async () => {
      const wrapper = mountEditor({ items: MIXED_ITEMS, menuMode: 'mixed' })
      await vi.waitUntil(() => !wrapper.vm.loading)

      const saved = wrapper.vm.buildSaveItems()

      expect(saved.map((i) => i.id)).toEqual(['pinned-before', 'stored-after'])
      expect(saved.find((i) => i.id === 'pinned-before').pinned).toBe('before')
      expect(saved.find((i) => i.id === 'stored-after').pinned).toBe('after')
    })

    it('keeps the Add control available, since there is still something of this menu to edit', async () => {
      const wrapper = mountEditor({ items: MIXED_ITEMS, menuMode: 'mixed' })
      await vi.waitUntil(() => !wrapper.vm.loading)

      expect(wrapper.findAll('button').some((b) => b.text().includes('Add'))).toBe(true)
    })

    it("does not disable a stored item's own detail panel", async () => {
      const wrapper = mountEditor({ items: MIXED_ITEMS, menuMode: 'mixed' })
      await vi.waitUntil(() => !wrapper.vm.loading)

      const rows = wrapper.findAll('.nav-edit-item-link')
      await rows[0].trigger('click')

      expect(wrapper.text()).not.toContain(
        'This menu is generated automatically from the page tree.'
      )
      expect(wrapper.findAll('button').some((b) => b.text().includes('Delete'))).toBe(true)
    })
  })

  /**
   * OpenProject #1012: `copyFrom()` persists immediately (`POST .../:navId/copy`), unlike every
   * other change in this editor, which stays local until the HOST's own Save button calls
   * `buildSaveItems()`. That means the host needs telling this one action already reached the
   * server, which is what the `copied` event is for -- see its own doc comment on the `defineEmits`
   * array.
   */
  describe('copy from... (OpenProject #1012)', () => {
    it("persists the copy immediately and emits 'copied', ahead of the editor's own Save", async () => {
      // -> Two roots (`copyLocales.length > 1`) is what makes `canCopyFrom` true and shows the action.
      const wrapper = mountEditor({
        roots: [
          { locale: 'en', navigationId: 'nav-1' },
          { locale: 'fr', navigationId: 'nav-fr' }
        ]
      })
      await vi.waitUntil(() => !wrapper.vm.loading)

      dialog.mockReturnValueOnce({
        onOk: (cb) => cb({ sourceSiteId: null, sourceNavId: 'nav-fr' })
      })
      API_CLIENT.post.mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ ok: true })
      })

      const panel = await openKebabMenu(wrapper)
      // -> The click listener lives on the `w-item` row's own root element, further up the DOM tree
      //    than this exact-text label -- dispatching here and letting it bubble reaches it either way.
      const copyLabel = Array.from(panel.querySelectorAll('*')).find(
        (el) => el.textContent.trim() === 'Copy from...'
      )
      copyLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await vi.waitUntil(() => API_CLIENT.post.mock.calls.length >= 1)
      await flushPromises()

      expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/navigation/nav-1/copy', {
        json: { sourceSiteId: null, sourceNavId: 'nav-fr', mode: 'append' }
      })
      expect(wrapper.emitted('copied')).toBeTruthy()
    })
  })
})

/**
 * OpenProject #2074: the "Add" button used to draw a ringed plus while every other create/add
 * affordance in the app drew a bare one. The add action is settled on `tabler:plus`, so this button
 * must not drift back to a ringed variant -- `tabler:circle-plus` is the one sitting closest to it
 * in the set.
 */
describe('NavItemEditor "Add" icon (OpenProject #2074)', () => {
  it('uses the settled tabler:plus add glyph, not tabler:circle-plus', async () => {
    const wrapper = mountEditor()
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:plus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:circle-plus"]').exists()).toBe(false)
  })
})
