import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { queue } from '@/composables/notify'
import { AsciidocRenderer } from '@/renderers/asciidoc'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `monaco-editor` needs real browser layout/measurement APIs (`ResizeObserver`, text metrics, a
 * genuine contenteditable surface) that `happy-dom` -- this workspace's Vitest environment, see
 * `vitest.config.js` -- does not provide, so mounting the real editor here would be testing whether
 * happy-dom can pretend to be a browser, not this component's own logic. Mocked to the handful of
 * calls `EditorAsciidoc.vue` actually makes, the same shape `EditorCode.test.js` relies on.
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
const EditorAsciidoc = (await import('./EditorAsciidoc.vue')).default

function mountEditor(initialContent = '') {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  const siteStore = useSiteStore()

  const i18n = createTestI18n()

  const wrapper = mount(EditorAsciidoc, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, siteStore }
}

/** The debounced content-change handler `EditorAsciidoc.vue` registers, captured off the fake editor. */
function changeHandler() {
  return fakeEditor.onDidChangeModelContent.mock.calls.at(-1)[0]
}

describe('EditorAsciidoc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the Monaco instance in plaintext language mode, seeded from the page store', () => {
    mountEditor('= Title\n\nExisting content.')

    expect(monaco.editor.create).toHaveBeenCalledTimes(1)
    const [, opts] = monaco.editor.create.mock.calls[0]
    expect(opts.language).toBe('plaintext')
    expect(opts.value).toBe('= Title\n\nExisting content.')
  })

  it('renders no live preview pane -- only the code editor, matching EditorCode.vue', () => {
    const { wrapper } = mountEditor('= Title')

    expect(wrapper.html()).not.toContain('v-html')
    expect(wrapper.find('[class*="preview"]').exists()).toBe(false)
  })

  it('converts the source to HTML into render on change, keeping content as the raw source', async () => {
    const { pageStore } = mountEditor('')
    fakeEditor.getValue.mockReturnValue('= Typed\n\nSome *text*.')

    changeHandler()()
    vi.advanceTimersByTime(500)
    await flushPromises()

    expect(pageStore.content).toBe('= Typed\n\nSome *text*.')
    expect(pageStore.render).toContain('<h1>Typed</h1>')
    expect(pageStore.render).toContain('<strong>text</strong>')
    expect(pageStore.contentLoaded).toBe(true)
  })

  it('keeps the last good render and notifies, rather than blanking it, when conversion throws', async () => {
    queue.splice(0, queue.length)
    const { pageStore } = mountEditor('')
    fakeEditor.getValue.mockReturnValue('Good text.')
    changeHandler()()
    vi.advanceTimersByTime(500)
    await flushPromises()
    const goodRender = pageStore.render
    expect(goodRender).toContain('Good text.')

    const renderSpy = vi
      .spyOn(AsciidocRenderer.prototype, 'render')
      .mockRejectedValueOnce(new Error('boom'))
    fakeEditor.getValue.mockReturnValue('Broken text.')
    changeHandler()()
    vi.advanceTimersByTime(500)
    await flushPromises()

    expect(pageStore.content).toBe('Broken text.')
    expect(pageStore.render).toBe(goodRender)
    expect(queue.at(-1)).toMatchObject({ type: 'negative' })

    renderSpy.mockRestore()
  })

  it('registers a contentFlusher that converts and patches render synchronously with the save', async () => {
    const { pageStore } = mountEditor('')
    const editorStore = useEditorStore()
    fakeEditor.getValue.mockReturnValue('Flushed *text*.')

    expect(editorStore.contentFlusher).toBeTypeOf('function')
    await editorStore.contentFlusher()

    expect(pageStore.content).toBe('Flushed *text*.')
    expect(pageStore.render).toContain('<strong>text</strong>')
  })

  it('clears the contentFlusher on unmount', () => {
    const { wrapper } = mountEditor('')
    const editorStore = useEditorStore()

    wrapper.unmount()

    expect(editorStore.contentFlusher).toBe(null)
  })

  /**
   * OpenProject #943, the #808 bug class: a debounced content-change call still pending at unmount
   * used to fire ~500ms later against the already-disposed editor. Typing then unmounting within the
   * debounce window must not touch the store afterward.
   */
  it('cancels the pending debounced content change on unmount instead of firing it later', async () => {
    const { wrapper, pageStore } = mountEditor('original')
    fakeEditor.getValue.mockReturnValue('typed but not yet flushed')

    changeHandler()()
    wrapper.unmount()
    vi.advanceTimersByTime(500)
    await flushPromises()

    expect(pageStore.content).toBe('original')
  })

  it('inserts AsciiDoc image macro syntax for an image asset picked from the file manager', () => {
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
    expect(edits[0].text).toBe('image::/media/photo.png[Photo]')
    expect(edits[0].range).toMatchObject({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 5
    })
  })

  it('inserts AsciiDoc link macro syntax for a non-image asset picked from the file manager', () => {
    mountEditor('')

    EVENT_BUS.emit('insertAsset', {
      type: 'asset',
      mimeType: 'application/pdf',
      title: 'Report',
      folderPath: '',
      fileName: 'report.pdf'
    })

    const [, edits] = fakeEditor.executeEdits.mock.calls[0]
    expect(edits[0].text).toBe('link:/report.pdf[Report]')
  })

  it('inserts AsciiDoc link macro syntax linking to a page picked from the file manager', () => {
    mountEditor('')

    EVENT_BUS.emit('insertAsset', {
      type: 'page',
      title: 'Getting Started',
      folderPath: 'docs',
      fileName: 'getting-started'
    })

    const [, edits] = fakeEditor.executeEdits.mock.calls[0]
    expect(edits[0].text).toBe('link:/docs/getting-started[Getting Started]')
  })

  /*
    `opens the file manager in insert mode from the sidebar button`, `stops listening for insertAsset
    and disposes the editor on unmount` and the whole `side toolbar tooltip mirroring` describe are
    byte-identical between this suite and its sibling markup editor's, so they live once, as a
    `describe.each` over both components, in `editorMarkupShared.test.js`.
  */
})
