import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PagePropertiesDialog from './PagePropertiesDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

const i18n = createTestI18n({
  editor: {
    props: {
      pageProperties: 'Page Properties',
      info: 'Info',
      title: 'Title',
      shortDescription: 'Short Description',
      icon: 'Icon',
      alias: 'Alias',
      publishState: 'Publish State',
      draft: 'Draft',
      published: 'Published',
      dateRange: 'Date Range',
      publishedHint: '',
      draftHint: '',
      dateRangeHint: '',
      relations: 'Relations',
      relationAdd: 'Add Relation',
      relationAddHint: '',
      sidebar: 'Sidebar',
      showSidebar: 'Show Sidebar',
      showToc: 'Show Table of Contents',
      tocMinMaxDepth: '',
      showTags: 'Show Tags',
      social: 'Social',
      allowComments: 'Allow Comments',
      allowContributions: 'Allow Contributions',
      tags: 'Tags',
      tagsPlaceholder: '',
      classification: 'Classification',
      classificationHint: '',
      classificationGuardHint: '',
      showInTree: 'Show in Tree',
      isSearchable: 'Searchable',
      requirePassword: 'Require Password',
      password: 'Password',
      passwordHint: '',
      passwordKeepHint: ''
    }
  },
  iconPicker: { open: 'Open Icon Picker' },
  common: { actions: { close: 'Close' } }
})

/**
 * `<page-tags edit />` is rendered unconditionally, so a mount that never overrides its
 * `siteStore.fetchTags()` call would otherwise leave an unresolved promise dangling across tests --
 * `flushPromises()` after mount settles it.
 */
function mountDialog({ pagePermissions = ['write:pages'] } = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const editorStore = useEditorStore()
  const userStore = useUserStore()
  userStore.pagePermissions = pagePermissions

  const wrapper = mount(PagePropertiesDialog, {
    global: { plugins: [i18n] }
  })
  return { wrapper, pageStore, siteStore, editorStore, userStore }
}

describe('PagePropertiesDialog', () => {
  /**
   * Regression coverage for OpenProject #1133 item 1: the Relations quick-access button used
   * `tabler:sun`, a copy-paste mistake -- not `tabler:link` or any other relations-shaped icon.
   */
  it('does not use the sun icon for the Relations quick-access button', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()

    expect(wrapper.find('.floating-sidepanel-quickaccess [data-icon="tabler:sun"]').exists()).toBe(
      false
    )
    expect(wrapper.find('.floating-sidepanel-quickaccess [data-icon="tabler:link"]').exists()).toBe(
      true
    )
  })

  /**
   * Regression coverage for OpenProject #1133 item 2: the icon-only quick-access buttons and the
   * panel's own close button had no `aria-label`, unlike every other icon-only button in this file.
   */
  it('sets an aria-label on every quick-access button and the close button', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()

    const quickAccessButtons = wrapper.findAll('.floating-sidepanel-quickaccess button')
    // -> One button per section: Info, Publish State, Relations, Sidebar, Social, Tags,
    //    Classification, Visibility
    expect(quickAccessButtons).toHaveLength(8)
    for (const btn of quickAccessButtons) {
      expect(btn.attributes('aria-label')).toBeTruthy()
    }

    const closeBtn = wrapper.find('.w-toolbar [data-icon="tabler:x"]').element.closest('button')
    expect(closeBtn.getAttribute('aria-label')).toBe('Close')
  })

  /**
   * OpenProject #2725: the "Open Icon Picker" button drew `tabler:icons` -- the icon for the
   * picker's own "Icons" tab, not the action of opening a search/pick UI. All three of this
   * button's call sites (this dialog, NavItemEditor, PageRelationDialog) settle on `tabler:search`.
   */
  it('uses the search icon, not tabler:icons, for the Open Icon Picker button', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()

    const openIconPickerBtn = wrapper.find('button[aria-label="Open Icon Picker"]')
    expect(openIconPickerBtn.exists()).toBe(true)
    expect(openIconPickerBtn.find('[data-icon="tabler:search"]').exists()).toBe(true)
    expect(openIconPickerBtn.find('[data-icon="tabler:icons"]').exists()).toBe(false)
  })

  /**
   * Regression coverage for OpenProject #1133 item 4: `state.requirePassword` used to be set once in
   * `onMounted`, with nothing keeping it in sync if `pageStore.hasPassword` arrived afterwards (e.g.
   * this panel mounting before `pageStore.pageLoad()` resolves). Watches `hasPassword` rather than
   * `password` itself (OpenProject #2232): the API never hands the actual password back, so
   * `hasPassword` is the only signal that a page already has one.
   */
  it('keeps requirePassword in sync when pageStore.hasPassword arrives after mount', async () => {
    const { wrapper, pageStore } = mountDialog()
    await flushPromises()

    // -> The password field itself is only rendered once `state.requirePassword` reads true
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)

    pageStore.hasPassword = true
    await nextTick()

    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
  })

  /**
   * OpenProject #2232: the password field never prefills from the server (it never sends the value
   * back), so it must start empty even when the page already has a password set -- and turning the
   * toggle off has to record an explicit removal, since an empty field alone cannot say "take it off"
   * apart from "never touched".
   */
  it('starts the password field empty and marks removePassword when the toggle is turned off', async () => {
    const { wrapper, pageStore } = mountDialog()
    await flushPromises()
    pageStore.hasPassword = true
    await nextTick()

    const pwdInput = wrapper.find('input[type="password"]')
    expect(pwdInput.exists()).toBe(true)
    expect(pwdInput.element.value).toBe('')
    expect(pageStore.removePassword).toBe(false)

    const toggles = wrapper.findAll('button[role="switch"]')
    const requirePasswordToggle = toggles.find((t) => t.text().includes('Require Password'))
    await requirePasswordToggle.trigger('click')
    await nextTick()

    expect(pageStore.password).toBe('')
    expect(pageStore.removePassword).toBe(true)
  })
})
