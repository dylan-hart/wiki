import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FolderCreateDialog from './FolderCreateDialog.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * The one representative mount proving `useDialogComponent({ autofocus })` really moves focus, for
 * every dialog that passes it. `<w-input autofocus>` does not: that attribute lands on
 * `WInput.vue`'s non-focusable root `<div>`.
 */
async function mountDialog() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const i18n = createTestI18n()
  // -> Stubbing `teleport` keeps `<w-dialog>`'s panel under the wrapper root so `find()` reaches
  //    it; `attachTo` is what makes `document.activeElement` reflect a `.focus()` call at all --
  //    happy-dom never considers a node on a detached tree active.
  const wrapper = mount(FolderCreateDialog, {
    global: { plugins: [i18n], stubs: { teleport: true } },
    attachTo: document.body
  })
  // -> Focus lands two ticks after mount: `useDialogComponent()` shows the panel on the first and
  //    focuses on the second, since the field does not exist until the panel does.
  await flushPromises()

  return { wrapper, siteStore }
}

describe('FolderCreateDialog', () => {
  it('moves focus into the title field once the dialog is open', async () => {
    const { wrapper } = await mountDialog()

    const titleInput = wrapper.find('input').element
    expect(document.activeElement).toBe(titleInput)
  })
})
