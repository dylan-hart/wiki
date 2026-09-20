import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'

function mountEditor(initialContent) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  const editorStore = useEditorStore()

  const i18n = createTestI18n()

  const wrapper = mount(EditorWysiwyg, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, editorStore }
}

function makeFile(name, type = 'image/png') {
  return new File(['x'], name, { type })
}

function findLinkTextNode(editor) {
  let found = null
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'link')) {
      found = node
    }
  })
  return found
}

function findImageNode(editor) {
  let found = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') {
      found = node
    }
  })
  return found
}

describe('EditorWysiwyg image-paste-to-asset-upload (OpenProject #2449)', () => {
  beforeEach(() => {
    // -> Deliberately empty: `mountEditor` already installs a fresh pinia per test
  })

  describe('paste', () => {
    it('claims a paste carrying only an image and inserts a real image node', async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      await wrapper.find('.ProseMirror').trigger('paste', {
        clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(1)
      const pending = editorStore.pendingAssets[0]
      // -> Every browser names a clipboard-pasted file "image.png", so the paste call site mints a
      //    unique one instead
      expect(pending.fileName).not.toBe('image.png')

      const imageNode = findImageNode(wrapper.vm.editor)
      expect(imageNode?.attrs.src).toBe(pending.blobUrl)
      expect(imageNode?.attrs.alt).toBe('image.png')

      wrapper.unmount()
    })

    it('claims a paste carrying a non-image file and inserts a link to its own name', async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      await wrapper.find('.ProseMirror').trigger('paste', {
        clipboardData: {
          files: [makeFile('quarterly-report.pdf', 'application/pdf')],
          types: ['Files'],
          getData: () => ''
        }
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(1)
      const pending = editorStore.pendingAssets[0]

      const linked = findLinkTextNode(wrapper.vm.editor)
      expect(linked?.text).toBe('quarterly-report.pdf')
      const mark = linked.marks.find((m) => m.type.name === 'link')
      expect(mark.attrs.href).toBe(pending.blobUrl)

      wrapper.unmount()
    })

    it('lets text win when an image rides alongside it on the clipboard', async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      await wrapper.find('.ProseMirror').trigger('paste', {
        clipboardData: {
          files: [makeFile('image.png')],
          types: ['Files', 'text/plain'],
          getData: (kind) => (kind === 'text/plain' ? 'from the spreadsheet' : '')
        }
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(0)
      expect(findImageNode(wrapper.vm.editor)).toBeNull()

      wrapper.unmount()
    })

    it('claims a paste whose files list is empty but items carries the file (OpenProject #2518)', async () => {
      // -> Some browsers leave `clipboardData.files` empty for a real pasted file and populate
      //    `.items` instead
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      const file = makeFile('image.png')
      await wrapper.find('.ProseMirror').trigger('paste', {
        clipboardData: {
          files: [],
          items: [{ kind: 'file', getAsFile: () => file }],
          types: ['Files'],
          getData: () => ''
        }
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(1)
      expect(findImageNode(wrapper.vm.editor)?.attrs.alt).toBe('image.png')

      wrapper.unmount()
    })

    it('leaves a plain-text-only paste alone entirely', async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      await wrapper.find('.ProseMirror').trigger('paste', {
        clipboardData: {
          files: [],
          types: ['text/plain'],
          getData: (kind) => (kind === 'text/plain' ? 'hello' : '')
        }
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(0)

      wrapper.unmount()
    })
  })

  describe('drop', () => {
    it("claims a drop and preserves the dropped file's real name", async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()

      const target = wrapper.find('.ProseMirror')
      await target.trigger('dragover', {
        dataTransfer: { files: [], types: ['Files'], getData: () => '' }
      })
      await target.trigger('drop', {
        dataTransfer: {
          files: [makeFile('quarterly-report.pdf', 'application/pdf')],
          types: ['Files'],
          getData: () => ''
        },
        clientX: 0,
        clientY: 0
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(1)
      // -> No unique name minted on the drop path: unlike a paste, a dropped file's name is real
      //    user intent
      expect(editorStore.pendingAssets[0].fileName).toBe('quarterly-report.pdf')

      const linked = findLinkTextNode(wrapper.vm.editor)
      expect(linked?.text).toBe('quarterly-report.pdf')

      wrapper.unmount()
    })

    it('claims a drop whose files list is empty but items carries the file (OpenProject #2518)', async () => {
      // -> Same empty-`files`-but-populated-`items` browser behaviour as the paste case, on the
      //    drop path
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()

      const file = makeFile('quarterly-report.pdf', 'application/pdf')
      const target = wrapper.find('.ProseMirror')
      await target.trigger('dragover', {
        dataTransfer: { files: [], types: ['Files'], getData: () => '' }
      })
      await target.trigger('drop', {
        dataTransfer: {
          files: [],
          items: [{ kind: 'file', getAsFile: () => file }],
          types: ['Files'],
          getData: () => ''
        },
        clientX: 0,
        clientY: 0
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(1)
      expect(editorStore.pendingAssets[0].fileName).toBe('quarterly-report.pdf')

      wrapper.unmount()
    })

    it('ignores a drop carrying no files', async () => {
      const { wrapper, editorStore } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()

      await wrapper.find('.ProseMirror').trigger('drop', {
        dataTransfer: { files: [], types: ['text/plain'], getData: () => '' },
        clientX: 0,
        clientY: 0
      })
      await nextTick()

      expect(editorStore.pendingAssets).toHaveLength(0)

      wrapper.unmount()
    })
  })

  describe('reloadEditorContent', () => {
    it("rewrites a pending asset's blob URL to its uploaded path on an image node", async () => {
      const { wrapper } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      wrapper.vm.editor.chain().focus().setImage({ src: 'blob:fake-1', alt: 'photo.png' }).run()
      await nextTick()

      EVENT_BUS.emit('reloadEditorContent', {
        replacements: [{ from: 'blob:fake-1', to: '/media/photo.png' }]
      })
      await nextTick()

      const imageNode = findImageNode(wrapper.vm.editor)
      expect(imageNode?.attrs.src).toBe('/media/photo.png')

      wrapper.unmount()
    })

    it("rewrites a pending asset's blob URL to its uploaded path on a link mark", async () => {
      const { wrapper } = mountEditor('')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      const { from } = wrapper.vm.editor.state.selection
      wrapper.vm.editor
        .chain()
        .focus()
        .insertContentAt(from, 'report.pdf')
        .setTextSelection({ from, to: from + 'report.pdf'.length })
        .extendMarkRange('link')
        .setLink({ href: 'blob:fake-2' })
        .run()
      await nextTick()

      EVENT_BUS.emit('reloadEditorContent', {
        replacements: [{ from: 'blob:fake-2', to: '/report.pdf' }]
      })
      await nextTick()

      const linked = findLinkTextNode(wrapper.vm.editor)
      const mark = linked.marks.find((m) => m.type.name === 'link')
      expect(mark.attrs.href).toBe('/report.pdf')

      wrapper.unmount()
    })

    it('does nothing when no replacement matches anything in the document', async () => {
      const { wrapper } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      wrapper.vm.editor.chain().focus().setImage({ src: 'blob:untouched', alt: 'x' }).run()
      await nextTick()

      expect(() =>
        EVENT_BUS.emit('reloadEditorContent', {
          replacements: [{ from: 'blob:not-there', to: '/elsewhere.png' }]
        })
      ).not.toThrow()
      await nextTick()

      expect(findImageNode(wrapper.vm.editor)?.attrs.src).toBe('blob:untouched')

      wrapper.unmount()
    })

    it('stops listening once unmounted', async () => {
      const { wrapper } = mountEditor('<p></p>')
      await nextTick()
      await nextTick()

      wrapper.unmount()

      // -> A listener still wired to the destroyed editor would throw on its torn-down `state`/`view`
      expect(() =>
        EVENT_BUS.emit('reloadEditorContent', {
          replacements: [{ from: 'blob:x', to: '/x.png' }]
        })
      ).not.toThrow()
    })
  })
})
