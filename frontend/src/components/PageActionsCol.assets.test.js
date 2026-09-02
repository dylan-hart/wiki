import { describe, expect, it, vi, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// -> `PageActionsCol.vue` imports `browser-fs-access` at module scope, so the module graph needs a
//    stand-in even in the shards that never assert on `fileSave` -- only `PageActionsCol.export`
//    reads its calls.
vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { clickByLabel, mountRailWithPendingAssets, typeInto } from './pageActionsHarness.js'

describe('PageActionsCol pending asset rename', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('shows the pending asset as plain text with no editable extension field', async () => {
    ;({ wrapper } = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    expect(document.body.textContent).toContain('a1b2c3.png')
    expect(document.querySelector('[aria-label="pageActions.renamePendingAsset"]')).not.toBeNull()
    expect(document.querySelector('input')).toBeNull()
  })

  it('opens an inline field pre-filled with the base name, extension shown fixed as a suffix', async () => {
    ;({ wrapper } = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()

    const input = document.querySelector('input')
    expect(input.value).toBe('a1b2c3')
    expect(document.body.textContent).toContain('.png')
  })

  it('commits a sanitized rename on Enter, keeping the fixed extension', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'Team Photo')
    document
      .querySelector('input')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('team-photo.png')
    // -> Back to read-only view, not left editing
    expect(document.querySelector('input')).toBeNull()
  })

  it('commits on the confirm button too', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'quarterly-report')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('quarterly-report.png')
  })

  it('leaves the file name untouched when Cancel is clicked instead', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'should-not-stick')
    clickByLabel('pageActions.cancelRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
    expect(document.body.textContent).toContain('a1b2c3.png')
  })

  it('leaves the file name untouched when Escape is pressed', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'should-not-stick')
    document
      .querySelector('input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
  })

  it('does not commit a rename that sanitizes down to empty, and stays in edit mode', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), '   ')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
    // -> Still editing: no fileName text node, the field is still there
    expect(document.querySelector('input')).not.toBeNull()
  })

  it('preserves a pending asset with no extension at all when renamed', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'screenshot', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'renamed')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('renamed')
  })
})
