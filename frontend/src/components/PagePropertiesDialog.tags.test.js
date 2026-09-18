import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PagePropertiesDialog from './PagePropertiesDialog.vue'
import { mountWithApp } from '../../test/mount.js'

const MESSAGES = {
  editor: {
    props: {
      info: 'Info',
      title: 'Title',
      publishState: 'Publishing State',
      relations: 'Relations',
      relationAdd: 'Add relation',
      relationAddHint: 'Add relation hint',
      sidebar: 'Sidebar',
      showSidebar: 'Show Sidebar',
      showTags: 'Show Tags',
      showToc: 'Show Table of Contents',
      social: 'Social',
      tags: 'Tags',
      tagsPlaceholder: 'Add a tag...',
      classification: 'Classification',
      classificationHint: 'classification hint',
      classificationGuardHint: 'classification guard hint',
      visibility: 'Visibility',
      published: 'Published',
      publishedHint: 'published hint',
      draft: 'Draft',
      draftHint: 'draft hint',
      dateRange: 'Date Range',
      dateRangeHint: 'date range hint',
      isSearchable: 'Include in Search Results',
      showInTree: 'Show in Site Navigation',
      password: 'Password',
      passwordHint: 'password hint',
      passwordKeepHint: 'password keep hint',
      requirePassword: 'Require Password',
      pageProperties: 'Page Properties',
      allowComments: 'Allow Comments',
      allowCommentsHint: 'allow comments hint',
      allowContributions: 'Allow Contributions',
      shortDescription: 'Short Description',
      icon: 'Icon',
      selectIcon: 'Select Icon...',
      alias: 'Alias'
    },
    pageRel: { title: 'Add Page Relation', titleEdit: 'Edit Page Relation' }
  },
  common: {
    actions: { viewDocs: 'View Docs', close: 'Close', edit: 'Edit', remove: 'Remove' }
  }
}

/**
 * OpenProject #3393: the Tags section (and its jump-rail entry) is gated on
 * `userStore.pagePermissions.includes('write:tags')` -- a PAGE-scoped permission, not
 * `userStore.can()` -- the same distinction `PagePropertiesDialog.scripts.test.js` already covers
 * for `write:scripts`/`write:styles`. Unlike the Scripts section, Tags has a read-only middle state:
 * a reader without `write:tags` still sees the section (and can browse to a tag) as long as the page
 * already carries at least one, and only loses the section entirely when there is also nothing to
 * show -- offering an editable field without the permission would look like it worked and then be
 * refused with 403 on save.
 */
describe('PagePropertiesDialog — Tags section permission gate', () => {
  it('hides the Tags section and its jump-rail entry for a reader with neither write:tags nor any existing tags', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages'] }, page: { tags: [] } }
    })
    await flushPromises()

    expect(wrapper.find('#refCardTags').exists()).toBe(false)
    expect(wrapper.findAll('[aria-label="Tags"]').length).toBe(0)
  })

  it('shows the Tags section read-only for a reader without write:tags on a page that already has tags', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages'] }, page: { tags: ['news'] } }
    })
    await flushPromises()

    const section = wrapper.find('#refCardTags')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('news')
    // -> No entry field and no removable chip without write:tags: `<page-tags :edit="false">` never
    //    renders the `w-select` input, and its chips are not `removable`.
    expect(section.find('input[aria-label="Tags"]').exists()).toBe(false)
  })

  it('shows the Tags section editable for a reader holding write:tags', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages', 'write:tags'] }, page: { tags: [] } }
    })
    await flushPromises()

    const section = wrapper.find('#refCardTags')
    expect(section.exists()).toBe(true)
    expect(section.find('input[aria-label="Tags"]').exists()).toBe(true)
    expect(wrapper.findAll('[aria-label="Tags"]').length).toBeGreaterThan(0)
  })
})
