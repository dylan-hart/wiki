import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import WTooltip from '@/components/shared/WTooltip.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * The behaviour `EditorAsciidoc.vue` and `EditorCode.vue` share verbatim, as one `describe.each` over
 * the two components rather than four byte-identical `it()` blocks copied between their two suites
 * (TEST-F13.9). This is not a deduplication that drops coverage: both components are still exercised,
 * each assertion still reports under its own component's name, and a third markup editor built on the
 * same `EditorMarkdown`-derived boot pattern joins by adding one row to `EDITORS`.
 *
 * What stays in each component's own suite is what actually differs: the Monaco language mode it
 * boots in, what it does with the source on change (AsciiDoc converts to HTML into `render`; the code
 * editor's raw source IS the render), and the insert syntax it writes for a picked asset.
 *
 * `monaco-editor` is mocked for the same reason both suites mock it: it needs real browser
 * layout/measurement APIs (`ResizeObserver`, text metrics, a genuine contenteditable surface) that
 * happy-dom does not provide, so mounting the real editor would test whether happy-dom can pretend to
 * be a browser rather than these components' own logic. One fake instance is shared by both, cleared
 * between tests.
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

const EDITORS = [
  ['EditorAsciidoc', (await import('./EditorAsciidoc.vue')).default],
  ['EditorCode', (await import('./EditorCode.vue')).default]
]

describe.each(EDITORS)('%s (behaviour shared by both markup editors)', (_name, Editor) => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.documentElement.removeAttribute('dir')
  })

  function mountEditor() {
    return mountWithApp(Editor, { stores: { page: { content: '' } } })
  }

  it('opens the file manager in insert mode from the sidebar button', async () => {
    const { wrapper, siteStore } = mountEditor()

    await wrapper.find('[aria-label="editor.markup.insertAssets"]').trigger('click')

    expect(siteStore.overlay).toBe('FileManager')
    expect(siteStore.overlayOpts).toEqual({ insertMode: true })
  })

  it('stops listening for insertAsset and disposes the editor on unmount', () => {
    const { wrapper } = mountEditor()

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
   * `EditorMarkdown.vue`'s own `sideToolbarTooltip` already covers; both editors were outside task
   * 721/727's audit.
   */
  describe('side toolbar tooltip mirroring', () => {
    it('anchors outward to the right under ltr (the default)', () => {
      document.documentElement.dir = 'ltr'
      const { wrapper } = mountEditor()

      const tooltip = wrapper.findComponent(WTooltip)
      expect(tooltip.props('anchor')).toBe('center right')
      expect(tooltip.props('self')).toBe('center left')
    })

    it('mirrors outward to the left under rtl', () => {
      document.documentElement.dir = 'rtl'
      const { wrapper } = mountEditor()

      const tooltip = wrapper.findComponent(WTooltip)
      expect(tooltip.props('anchor')).toBe('center left')
      expect(tooltip.props('self')).toBe('center right')
    })
  })
})
