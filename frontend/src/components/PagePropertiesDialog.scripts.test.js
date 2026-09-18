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
      scripts: 'Scripts',
      jsLoad: 'Javascript - On Load',
      jsLoadHint: 'jsLoad hint',
      jsUnload: 'Javascript - On Unload',
      jsUnloadHint: 'jsUnload hint',
      styles: 'CSS Styles',
      stylesHint: 'styles hint',
      sidebar: 'Sidebar',
      showSidebar: 'Show Sidebar',
      showTags: 'Show Tags',
      showToc: 'Show Table of Contents',
      social: 'Social',
      tags: 'Tags',
      classification: 'Classification',
      classificationHint: 'classification hint',
      classificationGuardHint: 'classification guard hint',
      pageScriptsDisabledHint: 'page scripts disabled hint',
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
    pageScripts: { title: 'Page Scripts' },
    pageRel: { title: 'Add Page Relation', titleEdit: 'Edit Page Relation' }
  },
  common: {
    actions: { viewDocs: 'View Docs', close: 'Close', edit: 'Edit', remove: 'Remove' }
  }
}

/**
 * OpenProject #3389/#3402: the Scripts section (and its jump-rail entry) is gated on
 * `userStore.pagePermissions.includes('write:scripts'/'write:styles')` -- PAGE-scoped permissions --
 * not `userStore.can()`, the same distinction `EditorMarkdown.vue` already draws for the content
 * sanitizer's own `write:scripts`/`write:styles` checks. Offering the section without the matching
 * permission would look like it worked and then be refused with 403 on save.
 */
describe('PagePropertiesDialog — Scripts section permission gate', () => {
  it('hides the Scripts section and its jump-rail entry for a reader with neither permission', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages'] } }
    })
    await flushPromises()

    expect(wrapper.find('#refCardScripts').exists()).toBe(false)
    expect(wrapper.findAll('[aria-label="Scripts"]').length).toBe(0)
  })

  it('shows the Scripts section for a reader holding write:scripts alone', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages', 'write:scripts'] } }
    })
    await flushPromises()

    const section = wrapper.find('#refCardScripts')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('Javascript - On Load')
    expect(section.text()).toContain('Javascript - On Unload')
    // -> write:scripts alone does not grant the CSS button
    expect(section.text()).not.toContain('CSS Styles')
    expect(wrapper.findAll('[aria-label="Scripts"]').length).toBe(1)
  })

  it('shows only the CSS Styles button for a reader holding write:styles alone', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: { user: { pagePermissions: ['write:pages', 'write:styles'] } }
    })
    await flushPromises()

    const section = wrapper.find('#refCardScripts')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('CSS Styles')
    expect(section.text()).not.toContain('Javascript - On Load')
  })

  it('opens PageScriptsDialog in jsLoad mode from the JS - On Load button', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: {
        ...MESSAGES,
        common: { actions: { ...MESSAGES.common.actions, discard: 'Discard', save: 'Save' } }
      },
      stores: { user: { pagePermissions: ['write:pages', 'write:scripts'] } },
      stubs: {}
    })
    await flushPromises()

    const loadBtn = wrapper.findAll('button').find((b) => b.text().includes('Javascript - On Load'))
    expect(loadBtn).toBeTruthy()
    await loadBtn.trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('Page Scripts')
  })
})

/**
 * OpenProject #3422: the site-wide `features.pageScripts` kill switch (Feature #3389 / Task #3403)
 * silently stops an authored script/style from ever executing -- no errors, no logs, no network
 * activity. The Scripts section is the only place an author holding write:scripts/write:styles is
 * told so, rather than discovering it by reading source or asking an admin.
 */
describe('PagePropertiesDialog — page scripts disabled hint', () => {
  it('shows the hint when the site has features.pageScripts off', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: {
        user: { pagePermissions: ['write:pages', 'write:scripts'] },
        site: (siteStore) => {
          siteStore.features.pageScripts = false
        }
      }
    })
    await flushPromises()

    const section = wrapper.find('#refCardScripts')
    expect(section.text()).toContain('page scripts disabled hint')
  })

  it('hides the hint when the site has features.pageScripts on', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: {
        user: { pagePermissions: ['write:pages', 'write:scripts'] },
        site: (siteStore) => {
          siteStore.features.pageScripts = true
        }
      }
    })
    await flushPromises()

    const section = wrapper.find('#refCardScripts')
    expect(section.text()).not.toContain('page scripts disabled hint')
  })

  it('does not show the hint at all when the reader holds neither script permission', async () => {
    const { wrapper } = mountWithApp(PagePropertiesDialog, {
      messages: MESSAGES,
      stores: {
        user: { pagePermissions: ['write:pages'] },
        site: (siteStore) => {
          siteStore.features.pageScripts = false
        }
      }
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain('page scripts disabled hint')
  })
})
