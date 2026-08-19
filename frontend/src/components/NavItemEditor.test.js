import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import NavItemEditor from './NavItemEditor.vue'

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
  'common.actions.delete': 'Delete'
}

const SERVER_ITEMS = [
  {
    id: 'parent-1',
    type: 'link',
    label: 'Parent',
    icon: 'mdi:text-box-outline',
    target: '/parent',
    openInNewWindow: false,
    expandByDefault: true,
    visibilityGroups: [],
    children: [
      {
        id: 'child-1',
        type: 'link',
        label: 'Child',
        icon: 'mdi:text-box-outline',
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

function mountEditor({ items = SERVER_ITEMS, groups = [], menuMode } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue(groups) }
    }
    return { json: vi.fn().mockResolvedValue(items) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  return mount(NavItemEditor, {
    props: { siteId: 'site-1', navId: 'nav-1', ...(menuMode && { menuMode }) },
    global: { plugins: [i18n] }
  })
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
        icon: 'mdi:text-box-outline',
        target: '/parent',
        openInNewWindow: false,
        expandByDefault: true,
        visibilityGroups: [],
        children: [
          {
            id: 'child-1',
            type: 'link',
            label: 'Child',
            icon: 'mdi:text-box-outline',
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

  it('emits load-error and notifies when the initial fetch fails', async () => {
    API_CLIENT.get.mockImplementation(() => {
      throw new Error('network down')
    })
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
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
})
