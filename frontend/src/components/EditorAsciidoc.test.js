import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import WTooltip from '@/components/shared/WTooltip.vue'

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

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

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

  it('renders no preview pane -- AsciiDoc rendering is deferred to a later Feature', () => {
    const { wrapper } = mountEditor('= Title')

    expect(wrapper.html()).not.toContain('v-html')
    expect(wrapper.find('[class*="preview"]').exists()).toBe(false)
  })

  it('submits the raw editor text as both content and render on change, matching the pageSave contract', () => {
    const { pageStore } = mountEditor('')
    fakeEditor.getValue.mockReturnValue('= Typed\n\nSome text.')

    changeHandler()()
    vi.advanceTimersByTime(500)

    expect(pageStore.content).toBe('= Typed\n\nSome text.')
    expect(pageStore.render).toBe('= Typed\n\nSome text.')
    expect(pageStore.contentLoaded).toBe(true)
  })

  it('opens the file manager in insert mode from the sidebar button', async () => {
    const { wrapper, siteStore } = mountEditor('')

    await wrapper.find('[aria-label="editor.markup.insertAssets"]').trigger('click')

    expect(siteStore.overlay).toBe('FileManager')
    expect(siteStore.overlayOpts).toEqual({ insertMode: true })
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

  it('stops listening for insertAsset and disposes the editor on unmount', () => {
    const { wrapper } = mountEditor('')

    wrapper.unmount()
    expect(fakeEditor.dispose).toHaveBeenCalledTimes(1)

    EVENT_BUS.emit('insertAsset', { type: 'asset', mimeType: 'image/png', title: 'x' })
    expect(fakeEditor.executeEdits).not.toHaveBeenCalled()
  })

  /**
   * OpenProject #834 (discussion #1738's editor-toolbar-mirroring gap): the side toolbar's tooltip
   * used to pop outward toward a hardcoded physical `right`, which is the reading-START edge of the
   * `Insert Assets` button only under LTR -- under RTL that edge is the visual left, and a tooltip
   * still anchored `right` pops away from the toolbar instead of back toward it. Same bug
   * `EditorMarkdown.vue`'s own `sideToolbarTooltip` already covers; this editor was outside task
   * 721/727's audit.
   */
  describe('side toolbar tooltip mirroring', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('dir')
    })

    it('anchors outward to the right under ltr (the default)', () => {
      document.documentElement.dir = 'ltr'
      const { wrapper } = mountEditor('')

      const tooltip = wrapper.findComponent(WTooltip)
      expect(tooltip.props('anchor')).toBe('center right')
      expect(tooltip.props('self')).toBe('center left')
    })

    it('mirrors outward to the left under rtl', () => {
      document.documentElement.dir = 'rtl'
      const { wrapper } = mountEditor('')

      const tooltip = wrapper.findComponent(WTooltip)
      expect(tooltip.props('anchor')).toBe('center left')
      expect(tooltip.props('self')).toBe('center right')
    })
  })
})
