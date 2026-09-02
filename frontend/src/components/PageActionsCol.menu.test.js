import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// -> `PageActionsCol.vue` imports `browser-fs-access` at module scope, so the module graph needs a
//    stand-in even in the shards that never assert on `fileSave` -- only `PageActionsCol.export`
//    reads its calls.
vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { queue as notifyQueue } from '@/composables/notify'
import { closeDialog, openDialogs } from '@/composables/dialog'

import {
  clickMenuItem,
  menuItemLabels,
  mountRailForGuard,
  mountRailWithPageActions
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

  // -> OpenProject #1917: View Backlinks is unconditional now, so unlike Rerender Page it never
  //    leaves the "..." trigger with nothing to show -- the button stays, just without Rerender Page.
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

  /**
   * OpenProject #1921: the dead menu-conversion placeholder item (and the `hasPageActions` computed
   * that existed only to keep this menu from opening empty for a guest) is gone entirely. This is the
   * scenario that computed used to guard -- a guest with neither `write:pages` nor `manage:pages` --
   * confirming the "..." trigger still renders and its menu still isn't empty, now on View Backlinks
   * alone, with no disabled placeholder standing in for the deleted entry.
   */
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

/**
 * OpenProject #1787: this `.onOk` handler used to call `pageStore.pageDuplicate(...)` with no
 * `await` and no `.catch` -- a rejection (the store's own `pageCreate` call, or the source-page
 * fetch before it) surfaced nowhere, leaving the reader with no feedback at all. Matches
 * `FileManager.vue`'s own duplicate handler, which already awaits and notifies.
 */
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

    await wrapper.get('[aria-label="pageActions.duplicatePage"]').trigger('click')
    expect(openDialogs).toHaveLength(1)

    closeDialog(openDialogs[0].id, true, { path: 'copy', title: 'Copy' })
    await flushPromises()

    expect(ctx.pageStore.pageDuplicate).toHaveBeenCalledWith({
      sourcePageId: 'page-1',
      path: 'copy',
      title: 'Copy'
    })
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'negative', message: 'Failed to duplicate page.' })
  })

  it('does not notify when the duplicate succeeds', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageDuplicate').mockResolvedValue(undefined)

    await wrapper.get('[aria-label="pageActions.duplicatePage"]').trigger('click')
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

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')

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

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
  })

  it('deletes an ordinary page with no extra guard', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'docs/getting-started' }))

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'page-1', pageName: 'Welcome' })
  })

  it('confirms before moving the home page off `home`', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailForGuard({ path: 'home' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
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

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
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

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
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

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
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
