import { beforeEach, describe, expect, it, vi } from 'vitest'
import { editorState, mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> See EditorMarkdown.assets.test.js's identical comment: `y-monaco` needs a real browser and is
//    never actually exercised here (collab is gated on a page id this harness never sets).
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/*
  OpenProject #2448 (Feature #2417): a paste carrying `text/html` is converted to markdown via
  `helpers/htmlToMarkdown.js` rather than left to the browser's default plain-text paste. The
  conversion itself is `htmlToMarkdown.test.js`'s job; this is the component-side proof that
  `onEditorPaste` actually reaches for it -- claims the event, inserts the converted markdown at the
  cursor, and leaves a plain-text-only paste (no `text/html`) alone for Monaco to handle as before.
*/
describe('EditorMarkdown HTML paste conversion (OpenProject #2448)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function clipboardWith({ html = '', text = '', files = [] } = {}) {
    return {
      files,
      getData: (type) => (type === 'text/html' ? html : type === 'text/plain' ? text : '')
    }
  }

  it('converts a pasted HTML fragment to markdown and inserts it at the cursor', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')

    await editorEl.trigger('paste', {
      clipboardData: clipboardWith({ html: '<p>Hello <strong>world</strong></p>' })
    })

    expect(editorState.fakeModel.getValue()).toBe('Hello **world**')
  })

  it('converts OneNote-style presentational markup (inline-style bold, a Unicode to-do glyph)', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html =
      '<p><span style="font-weight:bold">Action items</span></p>' + '<ul><li>☐ Follow up</li></ul>'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })

    const value = editorState.fakeModel.getValue()
    expect(value).toContain('**Action items**')
    expect(value).toMatch(/-\s+\[ \]\s+Follow up/)
  })

  it('leaves a plain-text-only paste (no text/html) for the default paste to handle', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ text: 'plain text' }) })

    // -> Neither branch of `onEditorPaste` claimed it, so nothing was inserted through Monaco's edit
    //    API -- the real browser/Monaco default (untestable here) is what would have inserted it.
    expect(editorState.fakeModel.getValue()).toBe('')
  })

  it('still claims a file paste over HTML when both are on the clipboard with no accompanying text', async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = (await import('@/stores/editor')).useEditorStore()
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const file = new File(['x'], 'image.png', { type: 'image/png' })

    await editorEl.trigger('paste', {
      clipboardData: clipboardWith({ html: '<p>ignored</p>', files: [file] })
    })

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorState.fakeModel.getValue()).not.toContain('ignored')
  })
})
