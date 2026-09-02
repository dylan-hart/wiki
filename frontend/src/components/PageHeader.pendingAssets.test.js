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

/**
 * OpenProject #945, item 2: `processPendingAssets()`'s `.onCancel(reject)` used to reject its
 * returned promise with no reason (`composables/dialog.js`'s `closeDialog` invokes every `cancel`
 * handler with no argument), and the three call sites all `await` it outside a try/catch in an async
 * function nothing else awaits either -- so cancelling (or failing) the pending-asset upload used to
 * surface as an unhandled promise rejection with an `undefined` reason instead of simply stopping the
 * save. This drives the real `UploadPendingAssetsDialog` open via `dialog()`'s own bookkeeping
 * (`openDialogs`/`closeDialog`) and closes it WITHOUT firing `ok`, the same shape a real cancel takes.
 */
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
    // -> Whatever this test's own dialog left behind, so it cannot bleed into a later test file's
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

    // -> `UploadPendingAssetsDialog` is now open (registered in `openDialogs` by `dialog()`); closing
    //    it without `okFired` is exactly what a reader dismissing/cancelling it does.
    expect(openDialogs).toHaveLength(1)
    closeDialog(openDialogs[0].id, false)

    // -> Give the microtask queue a turn to actually settle `processPendingAssets()`'s promise and
    //    run past the `if (!(await processPendingAssets())) { return }` guard.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(pageSaveSpy).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()

    process.off('unhandledRejection', unhandled)
  })
})
