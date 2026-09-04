import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
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
    await flushPromises()

    expect(editorState.fakeModel.getValue()).toBe('Hello **world**')
  })

  it('converts OneNote-style presentational markup (inline-style bold, a Unicode to-do glyph)', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html =
      '<p><span style="font-weight:bold">Action items</span></p>' + '<ul><li>☐ Follow up</li></ul>'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    const value = editorState.fakeModel.getValue()
    expect(value).toContain('**Action items**')
    expect(value).toMatch(/-\s+\[ \]\s+Follow up/)
  })

  it('leaves a plain-text-only paste (no text/html) for the default paste to handle', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ text: 'plain text' }) })
    await flushPromises()

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
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorState.fakeModel.getValue()).not.toContain('ignored')
  })
})

/*
  OpenProject #2504: a rich-HTML paste (OneNote, Word, a webpage selection, ...) that ALSO carries
  `text/html` -- i.e. every case `shouldClaimPaste` routes away from the bare file-paste branch above,
  since that branch only ever fires with no accompanying text -- must not silently lose its embedded
  images. `htmlToMarkdown.test.js` already covers the placeholder/`images` contract in isolation; this
  is the component-side proof that `onEditorPaste` resolves those placeholders into real pending
  assets via `fetch` + `editorStore.addPendingAsset`, the same pipeline a bare image paste already
  uses, before the markdown reaches the cursor.
*/
describe('EditorMarkdown HTML paste embedded images (OpenProject #2504)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function clipboardWith({ html = '', text = '', files = [] } = {}) {
    return {
      files,
      getData: (type) => (type === 'text/html' ? html : type === 'text/plain' ? text : '')
    }
  }

  function stubFetchOk(blob = new Blob(['fake-bytes'], { type: 'image/png' })) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(blob)
      })
    )
  }

  it('uploads an embedded image as a pending asset and rewrites its placeholder to the real blob: URL', async () => {
    stubFetchOk()
    const { wrapper } = await mountEditor('')
    const editorStore = (await import('@/stores/editor')).useEditorStore()
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html =
      '<p>Notes</p><img src="data:image/png;base64,AAAA" alt="screenshot"><p>More notes</p>'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(editorStore.pendingAssets).toHaveLength(1)
    const value = editorState.fakeModel.getValue()
    expect(value).toContain('Notes')
    expect(value).toContain('More notes')
    expect(value).toContain(`![screenshot](${editorStore.pendingAssets[0].blobUrl})`)
    expect(value).not.toContain('pending-image:')
    expect(value).not.toContain('data:image')
  })

  it('drops an image whose src cannot be fetched, without losing the surrounding text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const { wrapper } = await mountEditor('')
    const editorStore = (await import('@/stores/editor')).useEditorStore()
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html =
      '<p>Before</p><img src="https://other-origin.example/pic.png" alt="pic"><p>After</p>'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(0)
    const value = editorState.fakeModel.getValue()
    expect(value).toContain('Before')
    expect(value).toContain('After')
    expect(value).not.toContain('![')
    expect(value).not.toContain('pending-image:')
  })

  it('drops just the image that fails to fetch when a paste carries more than one', async () => {
    const goodBlob = new Blob(['ok'], { type: 'image/png' })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((src) =>
          src === 'data:image/png;base64,GOOD'
            ? Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(goodBlob) })
            : Promise.reject(new TypeError('Failed to fetch'))
        )
    )
    const { wrapper } = await mountEditor('')
    const editorStore = (await import('@/stores/editor')).useEditorStore()
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html =
      '<img src="data:image/png;base64,GOOD" alt="good">' +
      '<img src="https://other-origin.example/bad.png" alt="bad">'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(1)
    const value = editorState.fakeModel.getValue()
    expect(value).toContain(`![good](${editorStore.pendingAssets[0].blobUrl})`)
    expect(value).not.toContain('bad')
    expect(value).not.toContain('pending-image:')
  })

  it('response.ok === false is treated the same as a rejected fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, blob: () => Promise.resolve() })
    )
    const { wrapper } = await mountEditor('')
    const editorStore = (await import('@/stores/editor')).useEditorStore()
    editorState.cursorPosition = { lineNumber: 1, column: 1 }
    const editorEl = wrapper.find('.editor-markdown-editor')
    const html = '<img src="https://example.com/gone.png" alt="gone">'

    await editorEl.trigger('paste', { clipboardData: clipboardWith({ html }) })
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(0)
    expect(editorState.fakeModel.getValue()).toBe('')
  })
})
