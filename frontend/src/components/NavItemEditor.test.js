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
  'navEdit.groupsFailed': 'Failed to load the list of groups.'
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

function mountEditor({ items = SERVER_ITEMS, groups = [] } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue(groups) }
    }
    return { json: vi.fn().mockResolvedValue(items) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  return mount(NavItemEditor, {
    props: { siteId: 'site-1', navId: 'nav-1' },
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
})
