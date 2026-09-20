import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { editorState, mountEditorMarkdown } from './editorMarkdownHarness.js'
import { useEditorStore } from '@/stores/editor'
import { queue } from '@/composables/notify'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

function clipboardWith({ html = '', text = '', files = [] } = {}) {
  return {
    files,
    getData: (type) => (type === 'text/html' ? html : type === 'text/plain' ? text : '')
  }
}

const REFUSED = 'editor.pendingAssetsSuggestRefused'

describe('EditorMarkdown in suggest mode refuses files (OpenProject #3554)', () => {
  let wrapper
  let editorStore

  beforeEach(async () => {
    vi.clearAllMocks()
    queue.splice(0, queue.length)
    ;({ wrapper } = await mountEditorMarkdown(EditorMarkdown, ''))
    editorStore = useEditorStore()
    editorStore.mode = 'suggest'
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('declines a pasted file with a notice and queues nothing', async () => {
    const file = new File(['x'], 'image.png', { type: 'image/png' })

    await wrapper
      .find('.editor-markdown-editor')
      .trigger('paste', { clipboardData: clipboardWith({ files: [file] }) })
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(0)
    expect(editorState.fakeModel.getValue()).toBe('')
    expect(queue.map((n) => n.message)).toContain(REFUSED)
  })

  it('declines a dropped file with a notice and queues nothing', async () => {
    const file = new File(['x'], 'report.pdf', { type: 'application/pdf' })

    await wrapper.find('.editor-markdown-editor div').trigger('drop', {
      dataTransfer: { files: [file] },
      clientX: 0,
      clientY: 0
    })

    expect(editorStore.pendingAssets).toHaveLength(0)
    expect(editorState.fakeModel.getValue()).toBe('')
    expect(queue.map((n) => n.message)).toContain(REFUSED)
  })

  it('pastes the text of an HTML paste but drops its embedded image, with a notice', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const html = '<p>Before</p><img src="data:image/png;base64,GOOD" alt="pic"><p>After</p>'

    await wrapper
      .find('.editor-markdown-editor')
      .trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(editorStore.pendingAssets).toHaveLength(0)
    const value = editorState.fakeModel.getValue()
    expect(value).toContain('Before')
    expect(value).toContain('After')
    expect(value).not.toContain('![')
    expect(value).not.toContain('pending-image:')
    expect(queue.map((n) => n.message)).toContain(REFUSED)
  })

  it('still queues a pasted file outside suggest mode', async () => {
    editorStore.mode = 'edit'
    const file = new File(['x'], 'image.png', { type: 'image/png' })

    await wrapper
      .find('.editor-markdown-editor')
      .trigger('paste', { clipboardData: clipboardWith({ files: [file] }) })
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(queue.map((n) => n.message)).not.toContain(REFUSED)
  })
})
