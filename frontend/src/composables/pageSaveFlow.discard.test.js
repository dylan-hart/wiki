import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'

import { usePageSaveFlow } from './pageSaveFlow.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for OpenProject #2898: clicking Cancel/Discard after editing an existing page
 * used to leave the collab room's autosaved draft in place -- the next time that page was opened, the
 * reader was offered a "restore your draft?" prompt for content they had just explicitly discarded.
 *
 * `discardChanges()` needs a real component instance (it is registered via `usePageSaveFlow`, which
 * calls `useRouter`/`useRoute`/`useI18n`, all of which require an app context), so this mounts a
 * minimal host component through the same `mountWithApp` harness every other composable/component
 * suite uses rather than reaching for `vue-router`/`vue-i18n` mocks.
 */
function mountFlow(
  router,
  { isSuggesting = ref(false), processPendingAssets = vi.fn().mockResolvedValue(true) } = {}
) {
  const Host = defineComponent({
    setup() {
      return usePageSaveFlow({ isSuggesting, processPendingAssets })
    },
    render: () => null
  })

  return { isSuggesting, processPendingAssets, ...mountWithApp(Host, { router }) }
}

describe('usePageSaveFlow() discardChanges()', () => {
  let router

  beforeEach(async () => {
    router = await createTestRouter(['/'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes the recovery draft for the site/page being edited before reloading it', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({
      isActive: true,
      mode: 'edit',
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ hours: 1 })
    })
    vi.spyOn(pageStore, 'cancelPageEdit').mockResolvedValue()

    await wrapper.vm.discardChanges()

    expect(globalThis.API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/draft')
    expect(pageStore.cancelPageEdit).toHaveBeenCalled()
  })

  it('still discards the edit when the draft delete itself fails', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({
      isActive: true,
      mode: 'edit',
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ hours: 1 })
    })
    globalThis.API_CLIENT.delete.mockImplementationOnce(() => {
      throw new Error('network')
    })
    vi.spyOn(pageStore, 'cancelPageEdit').mockResolvedValue()

    await wrapper.vm.discardChanges()

    expect(pageStore.cancelPageEdit).toHaveBeenCalled()
    expect(editorStore.isActive).toBe(false)
  })

  it('does not touch the draft for a brand-new, never-saved page (create mode)', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({ isActive: true, mode: 'create' })

    await wrapper.vm.discardChanges()

    expect(globalThis.API_CLIENT.delete).not.toHaveBeenCalled()
  })

  /**
   * Regression coverage for OpenProject #3317: `editorStore.originPageId` is set by `pageCreate()`
   * (the page the reader was viewing when they opened a create-mode session) and read back by
   * `pageStore.cancelPageEdit()`. Left set after the create session that set it ends, it silently
   * outlives that session and gets picked up by a later, unrelated edit-mode discard -- navigating
   * the reader to a stale page instead of back to the one they were actually editing.
   */
  it('resets originPageId when discarding a create-mode session, so it cannot leak into a later edit session', async () => {
    const { wrapper, editorStore } = mountFlow(router)
    editorStore.$patch({ isActive: true, mode: 'create', originPageId: 'origin-page-1' })

    await wrapper.vm.discardChanges()

    expect(editorStore.originPageId).toBe('')
  })

  it('resets originPageId even when the (non-create) discard flow fails to reload the page', async () => {
    const { wrapper, pageStore, siteStore, editorStore } = mountFlow(router)
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    editorStore.$patch({
      isActive: true,
      mode: 'edit',
      // -> Simulates a leaked value from an earlier, unrelated create session
      originPageId: 'origin-page-1',
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ hours: 1 })
    })
    vi.spyOn(pageStore, 'cancelPageEdit').mockRejectedValue(new Error('network'))

    await wrapper.vm.discardChanges()

    expect(editorStore.originPageId).toBe('')
  })
})
