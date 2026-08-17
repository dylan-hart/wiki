import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import NavItemEditor from './NavItemEditor.vue'
import { dialog } from '@/composables/dialog'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))

/*
  `WMenu` (the kebab "more actions" menu) teleports its open content straight into `document.body`,
  independent of whichever wrapper mounted it -- and nothing here unmounts a wrapper between tests, so
  a menu left open by one test would otherwise still be sitting in `document.body` for the next one to
  find via a plain `[role="menu"]` query.
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
  'navEdit.clearItems': 'Clear All Items',
  'navEdit.copyFrom': 'Copy from...',
  'navEdit.copyFromWarn': 'Menu items copied. Review the copied links.'
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

function mountEditor({ items = SERVER_ITEMS, groups = [], roots = [], sites = [] } = {}) {
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
    return { json: vi.fn().mockResolvedValue(items) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  return mount(NavItemEditor, {
    props: { siteId: 'site-1', navId: 'nav-1' },
    global: { plugins: [i18n] }
  })
}

/** Opens the kebab ("more actions") menu and returns its teleported panel. */
async function openKebabMenu(wrapper) {
  await wrapper.find('button.ml-2').trigger('click')
  await vi.waitUntil(() => document.querySelector('[role="menu"]'))
  return document.querySelector('[role="menu"]')
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

    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: false, message: 'Nope.' })
    })
    const itemsBefore = wrapper.vm.buildSaveItems()

    await confirm({ sourceSiteId: 'site-1', sourceNavId: 'nav-2' })

    expect(wrapper.vm.buildSaveItems()).toEqual(itemsBefore)
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
