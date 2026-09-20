import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

async function mountHeader() {
  setActivePinia(createPinia())

  const editorStore = useEditorStore()
  editorStore.isActive = true
  editorStore.editor = 'markdown'
  editorStore.mode = 'edit'
  editorStore.lastSaveTimestamp = 1
  editorStore.lastChangeTimestamp = 2
  editorStore.pendingAssets = [
    { id: 'x', kind: 'file', file: { type: 'image/png' }, fileName: 'x.png', blobUrl: 'blob:x' }
  ]

  const pageStore = usePageStore()
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.features.reasonForChange = 'off'

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n()

  const wrapper = mount(PageHeader, { global: { plugins: [router, i18n] } })
  return { wrapper, editorStore, pageStore }
}

describe('PageHeader pending-asset upload cancellation (OpenProject #945)', () => {
  beforeEach(() => {
    queue.splice(0, queue.length)
  })

  afterEach(() => {
    // -> `openDialogs` is module state: an entry left behind bleeds into a later file's
    //    `<w-dialog-host>` render.
    openDialogs.splice(0, openDialogs.length)
  })

  it('stops the save, without an unhandled rejection, when the upload dialog is cancelled', async () => {
    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)

    const { wrapper, pageStore } = await mountHeader()
    const pageSaveSpy = vi.spyOn(pageStore, 'pageSave')

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await wrapper.vm.$nextTick()

    // -> Closing the open `UploadPendingAssetsDialog` without firing `ok` is the shape a reader
    //    dismissing it takes.
    expect(openDialogs).toHaveLength(1)
    closeDialog(openDialogs[0].id, false)

    // -> A macrotask turn, so `processPendingAssets()`'s promise settles and the save runs past its
    //    guard.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(pageSaveSpy).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()

    process.off('unhandledRejection', unhandled)
  })
})
