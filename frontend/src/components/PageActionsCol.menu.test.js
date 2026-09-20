import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// -> `PageActionsCol.vue` imports `browser-fs-access` at module scope, so the module graph needs a
//    stand-in even in a shard that never asserts on `fileSave`.
vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { queue as notifyQueue } from '@/composables/notify'
import { closeDialog, openDialogs } from '@/composables/dialog'

import {
  clickMenuItem,
  menuItemLabels,
  mountRailForGuard,
  mountRailWithPageActions,
  openPageActionsMenu
} from './pageActionsHarness.js'

describe('PageActionsCol page actions menu', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('offers Rerender Page when write:pages, Puppeteer and a markdown editor all line up', async () => {
    ;({ wrapper } = await mountRailWithPageActions())

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).toContain('Rerender Page')
  })

  it('keeps the "..." Page Actions button visible via View Backlinks even when Rerender Page cannot run', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ pdfExportAvailable: false }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).not.toContain('Rerender Page')
    expect(menuItemLabels()).toContain('View Backlinks')
  })

  it('keeps the Page Actions menu visible for a non-markdown editor, still offering View Backlinks', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ editor: 'code' }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).not.toContain('Rerender Page')
    expect(menuItemLabels()).toContain('View Backlinks')
  })

  it('shows a non-empty menu with only View Backlinks for a guest with no page permissions', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ canWritePages: false }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    const labels = menuItemLabels()
    expect(labels).toEqual(['View Backlinks'])
  })

  it('opens the backlinks side panel when View Backlinks is clicked', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    clickMenuItem('View Backlinks')
    await flushPromises()

    expect(ctx.siteStore.sideDialogComponent).toBe('PageBacklinksDialog')
    expect(ctx.siteStore.sideDialogShown).toBe(true)
  })
})

describe('PageActionsCol Convert Editor gate (OpenProject #3399)', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openDialogs.splice(0, openDialogs.length)
  })

  it('offers Convert Editor for a markdown page when both editors are active and write:pages is held', async () => {
    ;({ wrapper } = await mountRailWithPageActions())

    await openPageActionsMenu(wrapper)

    expect(menuItemLabels()).toContain('Convert Editor')
  })

  it('also offers Convert Editor for a wysiwyg page', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ editor: 'wysiwyg' }))

    await openPageActionsMenu(wrapper)

    expect(menuItemLabels()).toContain('Convert Editor')
  })

  it('hides Convert Editor for any other editor, e.g. code', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ editor: 'code' }))

    await openPageActionsMenu(wrapper)

    expect(menuItemLabels()).not.toContain('Convert Editor')
  })

  it('hides Convert Editor without write:pages', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ canWritePages: false }))

    await openPageActionsMenu(wrapper)

    expect(menuItemLabels()).not.toContain('Convert Editor')
  })

  it('hides Convert Editor when the site has only one of the two editors active', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ editors: { markdown: true, wysiwyg: false } }))

    await openPageActionsMenu(wrapper)

    expect(menuItemLabels()).not.toContain('Convert Editor')
  })

  it('opens PageConvertDialog on click, and reloads the page once it reports success', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageLoad').mockResolvedValue(undefined)

    await openPageActionsMenu(wrapper)
    clickMenuItem('Convert Editor')
    await flushPromises()

    expect(openDialogs).toHaveLength(1)

    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(ctx.pageStore.pageLoad).toHaveBeenCalledWith({ id: 'page-1' })
  })

  it('does not reload the page when the dialog is cancelled', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageLoad').mockResolvedValue(undefined)

    await openPageActionsMenu(wrapper)
    clickMenuItem('Convert Editor')
    await flushPromises()

    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(ctx.pageStore.pageLoad).not.toHaveBeenCalled()
  })
})

describe('PageActionsCol duplicate page (OpenProject #1787)', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openDialogs.splice(0, openDialogs.length)
  })

  it('notifies instead of leaving an unhandled rejection when pageDuplicate fails', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageDuplicate').mockRejectedValue(new Error('duplicate failed'))

    await openPageActionsMenu(wrapper)
    clickMenuItem('Duplicate Page')
    expect(openDialogs).toHaveLength(1)

    closeDialog(openDialogs[0].id, true, { path: 'copy', title: 'Copy' })
    await flushPromises()

    expect(ctx.pageStore.pageDuplicate).toHaveBeenCalledWith({
      sourcePageId: 'page-1',
      path: 'copy',
      title: 'Copy'
    })
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'negative', message: 'fileman.duplicateFailed' })
  })

  it('does not notify when the duplicate succeeds', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageDuplicate').mockResolvedValue(undefined)

    await openPageActionsMenu(wrapper)
    clickMenuItem('Duplicate Page')
    closeDialog(openDialogs[0].id, true, { path: 'copy', title: 'Copy' })
    await flushPromises()

    expect(notifyQueue).toHaveLength(0)
  })
})

describe('PageActionsCol homepage guard (WP #1149)', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openDialogs.splice(0, openDialogs.length)
  })

  it('confirms before deleting the home page, then opens the real delete dialog', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await openPageActionsMenu(wrapper)
    clickMenuItem('Delete Page')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Delete the Home Page?',
      cancel: true,
      color: 'negative'
    })
    expect(openDialogs[0].props.message).toContain('Welcome')

    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'page-1', pageName: 'Welcome' })
  })

  it('does not delete the home page when the guard is cancelled', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await openPageActionsMenu(wrapper)
    clickMenuItem('Delete Page')
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
  })

  it('deletes an ordinary page with no extra guard', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'docs/getting-started' }))

    await openPageActionsMenu(wrapper)
    clickMenuItem('Delete Page')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'page-1', pageName: 'Welcome' })
  })

  it('confirms before moving the home page off `home`', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailForGuard({ path: 'home' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await openPageActionsMenu(wrapper)
    clickMenuItem('Rename / Move Page')
    closeDialog(openDialogs[0].id, true, {
      path: 'about-us',
      title: 'Welcome',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Move the Home Page?',
      cancel: true,
      color: 'negative'
    })
    expect(API_CLIENT.put).not.toHaveBeenCalled()

    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/path`,
      expect.anything()
    )
  })

  it('does not move when the homepage move guard is cancelled', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await openPageActionsMenu(wrapper)
    clickMenuItem('Rename / Move Page')
    closeDialog(openDialogs[0].id, true, {
      path: 'about-us',
      title: 'Welcome',
      includeTranslations: false
    })
    await flushPromises()
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
    expect(openDialogs).toHaveLength(0)
  })

  it('does not guard a title-only rename of the home page (path unchanged)', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await openPageActionsMenu(wrapper)
    clickMenuItem('Rename / Move Page')
    closeDialog(openDialogs[0].id, true, {
      path: 'home',
      title: 'New Title',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.patch).toHaveBeenCalled()
    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('moves an ordinary page with no extra guard', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailForGuard({ path: 'docs/getting-started' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await openPageActionsMenu(wrapper)
    clickMenuItem('Rename / Move Page')
    closeDialog(openDialogs[0].id, true, {
      path: 'docs/other',
      title: 'Getting Started',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.put).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/path`,
      expect.anything()
    )
  })
})
