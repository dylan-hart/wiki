import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

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

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(EditorCode, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, siteStore }
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

  it('opens the file manager in insert mode from the sidebar button', async () => {
    const { wrapper, siteStore } = mountEditor('')

    await wrapper.find('[aria-label="editor.markup.insertAssets"]').trigger('click')

    expect(siteStore.overlay).toBe('FileManager')
    expect(siteStore.overlayOpts).toEqual({ insertMode: true })
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

  it('stops listening for insertAsset and disposes the editor on unmount', () => {
    const { wrapper } = mountEditor('')

    wrapper.unmount()
    expect(fakeEditor.dispose).toHaveBeenCalledTimes(1)

    EVENT_BUS.emit('insertAsset', { type: 'asset', mimeType: 'image/png', title: 'x' })
    expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
  })
})
