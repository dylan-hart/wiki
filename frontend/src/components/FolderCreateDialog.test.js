import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FolderCreateDialog from './FolderCreateDialog.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #1668: 13 dialogs carried a dead `<w-input autofocus>` attribute (it lands on
 * `WInput.vue`'s non-focusable root `<div>`) and opened with nothing focused. Each now passes
 * `useDialogComponent({ autofocus: () => iptX.value })` instead -- this is the one representative
 * mount `CLAUDE.md`'s testing convention asks for, proving the wiring actually works rather than
 * re-verifying it by hand in all 13.
 */
async function mountDialog() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const i18n = createTestI18n()
  // -> `<w-dialog>` teleports its panel to `<body>` (see `WDialog.vue`) -- stubbing `teleport` keeps
  //    it under the wrapper's own root so `wrapper.find()` can still reach it, and `attachTo` puts the
  //    wrapper itself in the real `document.body` so `document.activeElement` actually reflects a
  //    `.focus()` call instead of staying on a detached node happy-dom never considers "active".
  const wrapper = mount(FolderCreateDialog, {
    global: { plugins: [i18n], stubs: { teleport: true } },
    attachTo: document.body
  })
  // -> `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true one tick after
  //    mount, then focuses the field a SECOND tick after that (`composables/dialog.js`) -- the panel
  //    doesn't exist yet on the first tick, so the focus call is deliberately deferred past it.
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
