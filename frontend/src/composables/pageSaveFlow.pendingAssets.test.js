import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'

import { usePageSaveFlow } from './pageSaveFlow.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

function mountFlow(router) {
  const Host = defineComponent({
    setup() {
      return usePageSaveFlow({
        isSuggesting: ref(false),
        processPendingAssets: vi.fn().mockResolvedValue(true)
      })
    },
    render: () => null
  })
  return mountWithApp(Host, { router })
}

const pending = () => [{ id: 'x', kind: 'file', file: {}, fileName: 'x.png', blobUrl: 'blob:x' }]

describe('usePageSaveFlow(): pending assets end with the editing session (OpenProject #3554)', () => {
  let router

  beforeEach(async () => {
    router = await createTestRouter(['/'])
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops them when an edit-mode discard closes the editor', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({ isActive: true, mode: 'edit' })
    editorStore.pendingAssets = pending()
    vi.spyOn(pageStore, 'cancelPageEdit').mockResolvedValue()

    await wrapper.vm.discardChanges()

    expect(editorStore.pendingAssets).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  it('drops them when a create-mode discard closes the editor', async () => {
    const { wrapper, editorStore } = mountFlow(router)
    editorStore.$patch({ isActive: true, mode: 'create' })
    editorStore.pendingAssets = pending()

    await wrapper.vm.discardChanges()

    expect(editorStore.pendingAssets).toEqual([])
  })

  it('drops them even when the discard fails to reload the page', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({ isActive: true, mode: 'edit' })
    editorStore.pendingAssets = pending()
    vi.spyOn(pageStore, 'cancelPageEdit').mockRejectedValue(new Error('network'))

    await wrapper.vm.discardChanges()

    expect(editorStore.pendingAssets).toEqual([])
  })

  it('drops them when Save and Close closes the editor', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    siteStore.features.reasonForChange = 'off'
    editorStore.$patch({ isActive: true, mode: 'edit' })
    editorStore.pendingAssets = pending()
    vi.spyOn(pageStore, 'pageSave').mockResolvedValue({})

    await wrapper.vm.saveChanges(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(editorStore.isActive).toBe(false)
    expect(editorStore.pendingAssets).toEqual([])
  })

  it('keeps them when a plain save leaves the editor open', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    siteStore.features.reasonForChange = 'off'
    editorStore.$patch({ isActive: true, mode: 'edit' })
    editorStore.pendingAssets = pending()
    vi.spyOn(pageStore, 'pageSave').mockResolvedValue({})

    await wrapper.vm.saveChanges(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(editorStore.pendingAssets).toHaveLength(1)
  })
})
