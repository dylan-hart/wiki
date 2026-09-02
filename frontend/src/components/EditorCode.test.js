import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `monaco-editor` needs real browser layout/measurement APIs (`ResizeObserver`, text metrics, a
 * genuine contenteditable surface) that `happy-dom` -- this workspace's Vitest environment, see
 * `vitest.config.js` -- does not provide, so mounting the real editor here would be testing whether
 * happy-dom can pretend to be a browser, not this component's own logic. Mocked to the handful of
 * calls `EditorCode.vue` actually makes: `editor.create` returns one fake instance whose
 * `onDidChangeModelContent` callback and `getPosition`/`executeEdits` calls are captured so a test can
 * drive them directly, the same shape `EditorMarkdown.vue` (this component's own reused boot pattern)
 * relies on.
 */
const fakeEditor = {
  getValue: vi.fn(() => ''),
  getPosition: vi.fn(() => ({ lineNumber: 3, column: 5 })),
  executeEdits: vi.fn(),
  onDidChangeModelContent: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn()
}

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn((_el, opts) => {
      fakeEditor.getValue.mockReturnValue(opts.value)
      return fakeEditor
    })
  },
  Range: class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      this.startLineNumber = startLineNumber
      this.startColumn = startColumn
      this.endLineNumber = endLineNumber
      this.endColumn = endColumn
    }
  }
}))

const monaco = await import('monaco-editor')
const EditorCode = (await import('./EditorCode.vue')).default

function mountEditor(initialContent = '') {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  const siteStore = useSiteStore()

  const i18n = createTestI18n()

  const editorStore = useEditorStore()

  const wrapper = mount(EditorCode, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, siteStore, editorStore }
}

/** The debounced content-change handler `EditorCode.vue` registers, captured off the fake editor. */
function changeHandler() {
  return fakeEditor.onDidChangeModelContent.mock.calls.at(-1)[0]
}

describe('EditorCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the Monaco instance in html language mode, seeded from the page store', () => {
    mountEditor('<p>Existing content</p>')

    expect(monaco.editor.create).toHaveBeenCalledTimes(1)
    const [, opts] = monaco.editor.create.mock.calls[0]
    expect(opts.language).toBe('html')
    expect(opts.value).toBe('<p>Existing content</p>')
  })

  it('renders no preview pane -- the raw source is the render', () => {
    const { wrapper } = mountEditor('<p>Hello</p>')

    expect(wrapper.html()).not.toContain('v-html')
    expect(wrapper.find('[class*="preview"]').exists()).toBe(false)
  })

  it('submits the raw editor text as both content and render on change, matching the pageSave contract', () => {
    const { pageStore } = mountEditor('')
    fakeEditor.getValue.mockReturnValue('<h1>Typed</h1>')

    changeHandler()()
    vi.advanceTimersByTime(500)

    expect(pageStore.content).toBe('<h1>Typed</h1>')
    expect(pageStore.render).toBe('<h1>Typed</h1>')
    expect(pageStore.contentLoaded).toBe(true)
  })

  it('inserts an <img> tag at the cursor for an image asset picked from the file manager', () => {
    mountEditor('')

    EVENT_BUS.emit('insertAsset', {
      type: 'asset',
      mimeType: 'image/png',
      title: 'Photo',
      folderPath: 'media',
      fileName: 'photo.png'
    })

    expect(fakeEditor.executeEdits).toHaveBeenCalledTimes(1)
    const [, edits] = fakeEditor.executeEdits.mock.calls[0]
    expect(edits[0].text).toBe('<img src="/media/photo.png" alt="Photo">')
    expect(edits[0].range).toMatchObject({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 5
    })
  })

  it('inserts an <a> tag for a non-image asset picked from the file manager', () => {
    mountEditor('')

    EVENT_BUS.emit('insertAsset', {
      type: 'asset',
      mimeType: 'application/pdf',
      title: 'Report',
      folderPath: '',
      fileName: 'report.pdf'
    })

    const [, edits] = fakeEditor.executeEdits.mock.calls[0]
    expect(edits[0].text).toBe('<a href="/report.pdf">Report</a>')
  })

  it('inserts an <a> tag linking to a page picked from the file manager', () => {
    mountEditor('')

    EVENT_BUS.emit('insertAsset', {
      type: 'page',
      title: 'Getting Started',
      folderPath: 'docs',
      fileName: 'getting-started'
    })

    const [, edits] = fakeEditor.executeEdits.mock.calls[0]
    expect(edits[0].text).toBe('<a href="/docs/getting-started">Getting Started</a>')
  })

  /**
   * OpenProject #943: `pageSave()` calls `editorStore.contentFlusher?.()` before saving specifically
   * because the content-change handler is debounced -- without a registered flusher, typing then
   * immediately clicking Save (or Ctrl+S) within the 500ms window saves the page without the last
   * edits (the #806 bug class).
   */
  it('registers a contentFlusher that writes the editor value immediately, bypassing the debounce', () => {
    const { pageStore, editorStore } = mountEditor('')
    fakeEditor.getValue.mockReturnValue('<h1>Flushed</h1>')

    expect(editorStore.contentFlusher).toBeTypeOf('function')
    editorStore.contentFlusher()

    expect(pageStore.content).toBe('<h1>Flushed</h1>')
    expect(pageStore.render).toBe('<h1>Flushed</h1>')
  })

  it('clears its own contentFlusher on unmount', () => {
    const { wrapper, editorStore } = mountEditor('')

    wrapper.unmount()

    expect(editorStore.contentFlusher).toBe(null)
  })

  /**
   * OpenProject #943, the #808 bug class: a debounced content-change call still pending at unmount
   * used to fire ~500ms later against the already-disposed editor. Typing then unmounting within the
   * debounce window must not touch the store afterward.
   */
  it('cancels the pending debounced content change on unmount instead of firing it later', () => {
    const { wrapper, pageStore } = mountEditor('original')
    fakeEditor.getValue.mockReturnValue('typed but not yet flushed')

    changeHandler()()
    wrapper.unmount()
    vi.advanceTimersByTime(500)

    expect(pageStore.content).toBe('original')
  })

  /*
    `opens the file manager in insert mode from the sidebar button`, `stops listening for insertAsset
    and disposes the editor on unmount` and the whole `side toolbar tooltip mirroring` describe are
    byte-identical between this suite and its sibling markup editor's, so they live once, as a
    `describe.each` over both components, in `editorMarkupShared.test.js`.
  */
})
