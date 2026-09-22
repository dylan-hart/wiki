import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { queue as notifyQueue } from '@/composables/notify'
import { openDialogs } from '@/composables/dialog'

import {
  clickMenuItem,
  menuItemLabels,
  mountRailWithTemplates,
  openPageActionsMenu
} from './pageActionsHarness.js'

const SAVE = 'pageTemplateSave.menuItem'
const MANAGE = 'pageTemplateManage.menuItem'

async function labelsFor(options) {
  const ctx = await mountRailWithTemplates(options)
  await openPageActionsMenu(ctx.wrapper)
  return { ...ctx, labels: menuItemLabels() }
}

describe('PageActionsCol template actions', () => {
  let wrapper

  beforeEach(() => {
    openDialogs.splice(0, openDialogs.length)
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  describe('permission gate', () => {
    it('offers both actions to a holder of site:templates on this site', async () => {
      let labels
      ;({ wrapper, labels } = await labelsFor({
        sitePermissions: ['site:templates'],
        sitePermissionsSiteId: 'site-1'
      }))

      expect(labels).toContain(SAVE)
      expect(labels).toContain(MANAGE)
    })

    it('offers neither without site:templates', async () => {
      let labels
      ;({ wrapper, labels } = await labelsFor({
        sitePermissions: ['site:general'],
        sitePermissionsSiteId: 'site-1'
      }))

      expect(labels).not.toContain(SAVE)
      expect(labels).not.toContain(MANAGE)
    })

    it('refuses a site:templates grant that was fetched for a different site', async () => {
      let labels
      ;({ wrapper, labels } = await labelsFor({
        sitePermissions: ['site:templates'],
        sitePermissionsSiteId: 'site-2'
      }))

      expect(labels).not.toContain(SAVE)
      expect(labels).not.toContain(MANAGE)
    })

    it('follows the manage:sites fallback the backend also accepts', async () => {
      let labels
      ;({ wrapper, labels } = await labelsFor({
        permissions: ['manage:sites', 'read:source'],
        sitePermissions: [],
        sitePermissionsSiteId: null
      }))

      expect(labels).toContain(SAVE)
      expect(labels).toContain(MANAGE)
    })

    it('fetches the site permissions itself and shows the actions once they arrive', async () => {
      let labels, userStore
      ;({ wrapper, labels, userStore } = await labelsFor({
        sitePermissions: [],
        sitePermissionsSiteId: null,
        fetchedPermissions: ['site:templates']
      }))

      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/userPermissions')
      expect(userStore.canOnSite('site:templates', 'site-1')).toBe(true)
      expect(labels).toContain(SAVE)
      expect(labels).toContain(MANAGE)
    })

    it('does not fetch for a guest', async () => {
      ;({ wrapper } = await mountRailWithTemplates({ authenticated: false }))

      expect(API_CLIENT.get).not.toHaveBeenCalled()
    })

    it('keeps Manage but hides Save without read:source', async () => {
      let labels
      ;({ wrapper, labels } = await labelsFor({
        permissions: [],
        sitePermissions: ['site:templates']
      }))

      expect(labels).not.toContain(SAVE)
      expect(labels).toContain(MANAGE)
    })

    it('offers neither on a redirection, whose page-actions menu is absent altogether', async () => {
      ;({ wrapper } = await mountRailWithTemplates({
        sitePermissions: ['site:templates'],
        editor: 'redirect'
      }))

      expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(false)
    })
  })

  describe('Save as template', () => {
    it("opens the save dialog with the loaded page's content and editor", async () => {
      ;({ wrapper } = await mountRailWithTemplates({
        sitePermissions: ['site:templates'],
        editor: 'wysiwyg',
        page: {
          title: 'Meeting notes',
          description: 'Weekly',
          content: '# Agenda\n',
          contentLoaded: true
        }
      }))
      await openPageActionsMenu(wrapper)

      clickMenuItem(SAVE)
      await flushPromises()

      expect(API_CLIENT.get).not.toHaveBeenCalled()
      expect(openDialogs).toHaveLength(1)
      expect(openDialogs[0].props).toEqual({
        content: '# Agenda\n',
        editor: 'wysiwyg',
        locale: 'en',
        defaultName: 'Meeting notes',
        defaultDescription: 'Weekly'
      })
    })

    it('reads the source from the export endpoint when the page was loaded without it', async () => {
      ;({ wrapper } = await mountRailWithTemplates({
        sitePermissions: ['site:templates'],
        page: { title: 'Notes', contentLoaded: false, content: '' }
      }))
      await openPageActionsMenu(wrapper)
      API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# From export') })

      clickMenuItem(SAVE)
      await flushPromises()

      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-1/export', {
        searchParams: { format: 'markdown' }
      })
      expect(openDialogs[0].props.content).toBe('# From export')
    })

    it('flushes the mounted editor before reading what it holds', async () => {
      let ctx
      ;({ wrapper } = ctx = await mountRailWithTemplates({
        sitePermissions: ['site:templates'],
        page: { title: 'Draft', content: 'stale', contentLoaded: true }
      }))
      ctx.editorStore.$patch({ isActive: true, mode: 'edit' })
      ctx.editorStore.contentFlusher = vi.fn(async () => {
        ctx.pageStore.content = 'fresh'
      })
      await openPageActionsMenu(wrapper)

      clickMenuItem(SAVE)
      await flushPromises()

      expect(openDialogs[0].props.content).toBe('fresh')
    })

    it('reports a failed source read and opens no dialog', async () => {
      ;({ wrapper } = await mountRailWithTemplates({
        sitePermissions: ['site:templates'],
        page: { contentLoaded: false, content: '' }
      }))
      await openPageActionsMenu(wrapper)
      API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockRejectedValue(new Error('403')) })

      clickMenuItem(SAVE)
      await flushPromises()

      expect(openDialogs).toHaveLength(0)
      expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
    })
  })

  describe('Manage templates', () => {
    it('opens the manage dialog', async () => {
      ;({ wrapper } = await mountRailWithTemplates({ sitePermissions: ['site:templates'] }))
      await openPageActionsMenu(wrapper)

      clickMenuItem(MANAGE)
      await flushPromises()

      expect(openDialogs).toHaveLength(1)
    })
  })
})
