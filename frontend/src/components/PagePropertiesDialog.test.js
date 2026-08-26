import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PagePropertiesDialog from './PagePropertiesDialog.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
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
          allowRatings: 'Allow Ratings',
          tags: 'Tags',
          tagsPlaceholder: '',
          classification: 'Classification',
          classificationHint: '',
          classificationGuardHint: '',
          showInTree: 'Show in Tree',
          isSearchable: 'Searchable',
          requirePassword: 'Require Password',
          password: 'Password',
          passwordHint: ''
        }
      },
      iconPicker: { open: 'Open Icon Picker' },
      common: { actions: { close: 'Close' } }
    }
  }
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
   * `la:sun`, a copy-paste mistake -- not `la:link` or any other relations-shaped icon.
   */
  it('does not use the sun icon for the Relations quick-access button', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()

    expect(wrapper.find('.floating-sidepanel-quickaccess [data-icon="la:sun"]').exists()).toBe(
      false
    )
    expect(wrapper.find('.floating-sidepanel-quickaccess [data-icon="la:link"]').exists()).toBe(
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

    const closeBtn = wrapper.find('.w-toolbar [data-icon="la:times"]').element.closest('button')
    expect(closeBtn.getAttribute('aria-label')).toBe('Close')
  })

  /**
   * Regression coverage for OpenProject #1133 item 4: `state.requirePassword` used to be set once in
   * `onMounted`, with nothing keeping it in sync if `pageStore.password` arrived afterwards (e.g. this
   * panel mounting before `pageStore.pageLoad()` resolves).
   */
  it('keeps requirePassword in sync when pageStore.password arrives after mount', async () => {
    const { wrapper, pageStore } = mountDialog()
    await flushPromises()

    // -> The password field itself is only rendered once `state.requirePassword` reads true
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)

    pageStore.password = 'sup3r-secret'
    await nextTick()

    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
  })
})
