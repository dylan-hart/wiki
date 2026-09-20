import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useUserStore } from '@/stores/user'

import { openDialogs } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

async function mountSuggesting() {
  setActivePinia(createPinia())

  const editorStore = useEditorStore()
  editorStore.isActive = true
  editorStore.editor = 'markdown'
  editorStore.mode = 'suggest'
  editorStore.lastSaveTimestamp = 1
  editorStore.lastChangeTimestamp = 2

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.editor = 'markdown'
  vi.spyOn(pageStore, 'pageSubmitSuggestion').mockResolvedValue({})
  vi.spyOn(pageStore, 'pageLoad').mockResolvedValue()

  useUserStore().authenticated = true

  const router = await createTestRouter(['/'])
  const wrapper = mount(PageHeader, { global: { plugins: [router, createTestI18n()] } })
  return { wrapper, editorStore }
}

describe('PageHeader submitting a suggestion (OpenProject #3554)', () => {
  afterEach(() => {
    openDialogs.splice(0, openDialogs.length)
    vi.restoreAllMocks()
  })

  it('ends the session: the editor closes and any pending assets are dropped', async () => {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { wrapper, editorStore } = await mountSuggesting()
    editorStore.pendingAssets = [
      { id: 'x', kind: 'file', file: {}, fileName: 'x.png', blobUrl: 'blob:x' }
    ]

    await wrapper.find('[aria-label="common.actions.submitEdits"]').trigger('click')
    await flushPromises()

    expect(editorStore.isActive).toBe(false)
    expect(editorStore.pendingAssets).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})
