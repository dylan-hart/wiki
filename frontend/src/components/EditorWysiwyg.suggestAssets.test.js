import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { queue } from '@/composables/notify'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'

const REFUSED = 'editor.pendingAssetsSuggestRefused'

function mountEditor(mode) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = '<p></p>'
  const editorStore = useEditorStore()
  editorStore.mode = mode

  const wrapper = mount(EditorWysiwyg, { global: { plugins: [createTestI18n()] } })
  return { wrapper, editorStore }
}

const makeFile = (name, type = 'image/png') => new File(['x'], name, { type })

describe('EditorWysiwyg in suggest mode refuses files (OpenProject #3554)', () => {
  beforeEach(() => {
    queue.splice(0, queue.length)
  })

  it('declines a pasted file with a notice and queues nothing', async () => {
    const { wrapper, editorStore } = mountEditor('suggest')
    await nextTick()
    await nextTick()

    await wrapper.find('.ProseMirror').trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
    })
    await nextTick()

    expect(editorStore.pendingAssets).toHaveLength(0)
    expect(queue.map((n) => n.message)).toContain(REFUSED)
    wrapper.unmount()
  })

  it('declines a dropped file with a notice and queues nothing', async () => {
    const { wrapper, editorStore } = mountEditor('suggest')
    await nextTick()
    await nextTick()

    await wrapper.find('.ProseMirror').trigger('drop', {
      dataTransfer: {
        files: [makeFile('report.pdf', 'application/pdf')],
        types: ['Files'],
        getData: () => ''
      },
      clientX: 0,
      clientY: 0
    })
    await nextTick()

    expect(editorStore.pendingAssets).toHaveLength(0)
    expect(queue.map((n) => n.message)).toContain(REFUSED)
    wrapper.unmount()
  })

  it('still queues a pasted file outside suggest mode', async () => {
    const { wrapper, editorStore } = mountEditor('edit')
    await nextTick()
    await nextTick()
    wrapper.vm.editor.commands.setTextSelection(1)

    await wrapper.find('.ProseMirror').trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
    })
    await nextTick()

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(queue.map((n) => n.message)).not.toContain(REFUSED)
    wrapper.unmount()
  })
})
