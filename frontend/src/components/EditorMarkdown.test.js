import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import { usePageStore } from '@/stores/page'
import { useEditorStore } from '@/stores/editor'
import WBtn from '@/components/shared/WBtn.vue'

/**
 * `monaco-editor` needs real browser layout/measurement APIs that `happy-dom` (this workspace's
 * Vitest environment, see `vitest.config.js`) does not provide, so mounting the real editor here
 * would be testing whether happy-dom can pretend to be a browser, not this component's own logic.
 * Mocked to the handful of calls `EditorMarkdown.vue` actually makes at mount time -- the same
 * reused boot pattern `EditorCode.test.js` documents and relies on.
 *
 * Unlike that lighter mock, `fakeModel` here actually applies edits to a line buffer rather than
 * merely recording them: the bug under test (OpenProject #803) is specifically about the SECOND
 * edit's range going stale once the FIRST edit has already changed the document, which a mock that
 * only records `executeEdits` calls without applying them could never catch.
 */
function createFakeModel(initialValue) {
  let lines = initialValue.split('\n')
  return {
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (lineNumber) => lines[lineNumber - 1] ?? '',
    getLineMaxColumn: (lineNumber) => (lines[lineNumber - 1] ?? '').length + 1,
    /** Applies one Monaco-shaped edit ({ range, text }) to the buffer, in place. */
    applyEdit({ range, text }) {
      const startLine = lines[range.startLineNumber - 1] ?? ''
      const endLine = lines[range.endLineNumber - 1] ?? ''
      const before = startLine.slice(0, range.startColumn - 1)
      const after = endLine.slice(range.endColumn - 1)
      const inserted = text.split('\n')
      inserted[0] = before + inserted[0]
      inserted[inserted.length - 1] += after
      lines.splice(
        range.startLineNumber - 1,
        range.endLineNumber - range.startLineNumber + 1,
        ...inserted
      )
    }
  }
}

let fakeModel
let cursorPosition
const fakeEditor = {
  getModel: vi.fn(() => fakeModel),
  getValue: vi.fn(() => fakeModel.getValue()),
  getPosition: vi.fn(() => cursorPosition),
  setPosition: vi.fn((pos) => {
    cursorPosition = pos
  }),
  // -> Only consulted by `onEditorDrop` to move the cursor to the drop point; `null` exercises its
  //    `if (target?.position)` no-op guard, which is all a happy-dom drop event needs here.
  getTargetAtClientPoint: vi.fn(() => null),
  executeEdits: vi.fn((_source, edits) => {
    for (const edit of edits) {
      fakeModel.applyEdit(edit)
    }
  }),
  updateOptions: vi.fn(),
  addCommand: vi.fn(() => 'fake-command-id'),
  addAction: vi.fn(),
  onDidChangeModelContent: vi.fn(),
  onDidChangeCursorPosition: vi.fn(),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn()
}

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn((_el, opts) => {
      fakeModel = createFakeModel(opts.value ?? '')
      cursorPosition = { lineNumber: fakeModel.getLineCount(), column: 1 }
      return fakeEditor
    })
  },
  languages: {
    setLanguageConfiguration: vi.fn(),
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() }))
  },
  KeyMod: { CtrlCmd: 1, Alt: 2 },
  KeyCode: { KeyB: 1, KeyI: 2, KeyS: 3, RightArrow: 4, LeftArrow: 5 },
  Range: class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      this.startLineNumber = startLineNumber
      this.startColumn = startColumn
      this.endLineNumber = endLineNumber
      this.endColumn = endColumn
    }
  },
  Position: class Position {
    constructor(lineNumber, column) {
      this.lineNumber = lineNumber
      this.column = column
    }
  },
  Selection: class Selection {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      this.startLineNumber = startLineNumber
      this.startColumn = startColumn
      this.endLineNumber = endLineNumber
      this.endColumn = endColumn
    }
  }
}))

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

async function mountEditor(initialContent = '') {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(EditorMarkdown, {
    global: { plugins: [i18n] }
  })
  // -> `onMounted` is async (awaits `loadSiteBlocks`/`fetchUserSettings` before creating the editor)
  await flushPromises()

  return { wrapper, pageStore }
}

/*
  The Insert Footnote toolbar button carries no `aria-label` of its own (unlike, say,
  `EditorCode.vue`'s equivalent), so it can't be found by that selector -- its `icon` prop is unique
  among the sidebar buttons instead.
*/
async function clickInsertFootnote(wrapper) {
  const button = wrapper
    .findAllComponents(WBtn)
    .find((candidate) => candidate.props('icon') === 'mdi:book-plus')
  await button.trigger('click')
}

describe('EditorMarkdown insertFootnote (OpenProject #803)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inserts a marker inline and an appended note when the cursor is mid-document', async () => {
    const { wrapper } = await mountEditor('Line one.\nLine two.')
    cursorPosition = { lineNumber: 1, column: 5 }

    await clickInsertFootnote(wrapper)

    expect(fakeModel.getValue()).toBe('Line[^1] one.\nLine two.\n\n[^1]: ')
  })

  it('separates marker and note on a document that starts completely empty', async () => {
    const { wrapper } = await mountEditor('')
    cursorPosition = { lineNumber: 1, column: 1 }

    await clickInsertFootnote(wrapper)

    // -> The cursor is trivially "at the document end" here too (an empty document has nowhere
    //    else for it to be), which collided the two edit ranges pre-fix the same as the non-empty
    //    case above.
    expect(fakeModel.getValue()).toBe('[^1]\n\n[^1]: ')
  })

  it('inserts a marker and a separately-delimited note when the cursor is at the document end', async () => {
    const { wrapper } = await mountEditor('Some text.')
    // -> Cursor already at the exact end of the document, the same state a real editor is left in
    //    right after a previous footnote insertion -- and the state that collapsed the two edit
    //    ranges together before this fix.
    cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

    await clickInsertFootnote(wrapper)

    expect(fakeModel.getValue()).toBe('Some text.[^1]\n\n[^1]: ')
  })

  it('keeps marker and note separated across two footnote insertions with no cursor movement between them', async () => {
    const { wrapper } = await mountEditor('Some text.')
    cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

    await clickInsertFootnote(wrapper)
    /*
      `insertFootnote` parks the cursor at the end of the note it just wrote (see the function's own
      doc comment), with no intervening cursor movement -- exactly the real-world trigger from two
      toolbar clicks in a row. The second marker therefore lands right after the first note, on the
      note's own line: correct (the marker is inserted "where the cursor is", same as always), and
      NOT the bug -- the bug was the marker and note text landing concatenated on top of each other
      with no delimiter at all, because both edit ranges had collapsed onto the same position.
    */
    await clickInsertFootnote(wrapper)

    const value = fakeModel.getValue()
    expect(value).toBe('Some text.[^1]\n\n[^1]: [^2]\n\n[^2]: ')
    // -> The actual regression (OpenProject #803): marker and note glued together with no separator,
    //    e.g. "[^2][^2]: " -- a marker followed immediately by its own note prefix.
    expect(value).not.toMatch(/\[\^2\]\[\^2\]:/)
    expect(value).not.toMatch(/\[\^1\]\[\^1\]:/)
    // -> Both notes exist, each on its own line, each still resolvable to its marker.
    expect(value).toContain('[^1]: ')
    expect(value).toContain('[^2]: ')
  })
})

/*
  `pageStore.pageSave()` (`stores/page.js`) calls `editorStore.contentFlusher()` immediately before
  reading `content`/`render`, rather than trusting whatever the debounced `onDidChangeModelContent`
  handler below has synced so far -- see that call site for why (OpenProject #806: a pasted image's
  `blob:` URL rewrite, applied straight to the Monaco model, could otherwise still be sitting in that
  500ms debounce window when a save fires). These two tests are the component-side half of that fix:
  proof the mounted editor actually registers something on `editorStore.contentFlusher`, and clears it
  again on unmount -- the store-level tests in `stores/page.test.js` only prove `pageSave()` calls
  whatever is registered, not that this component is the thing registering it.
*/
describe('EditorMarkdown content flusher (OpenProject #806)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers a synchronous flusher on mount that reads the live editor value straight into the store', async () => {
    const { pageStore } = await mountEditor('Some text.')
    const editorStore = useEditorStore()

    expect(typeof editorStore.contentFlusher).toBe('function')

    // -> Applied straight to the fake model, the same way `reloadEditorContent`'s `executeEdits` call
    //    rewrites a pending asset's blob URL -- and, like that edit, not yet synced into the store by
    //    the debounced change handler (`onDidChangeModelContent` is mocked out in this harness, so it
    //    never fires at all here; the point is only that the flusher does not depend on it having
    //    fired).
    fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'PASTED '
    })
    expect(pageStore.content).not.toContain('PASTED')

    editorStore.contentFlusher()

    expect(pageStore.content).toBe(fakeModel.getValue())
    expect(pageStore.content).toContain('PASTED')
  })

  it('clears the flusher on unmount, so a save with no editor mounted does not call a disposed one', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const editorStore = useEditorStore()
    expect(editorStore.contentFlusher).not.toBeNull()

    wrapper.unmount()

    expect(editorStore.contentFlusher).toBeNull()
  })
})

/*
  OpenProject #806 follow-up: every browser hands a clipboard-pasted file the same literal name,
  "image.png" -- so `addPendingAsset` mints a fresh unique name for a pasted `File`, but a dropped
  `File`'s name is real user intent and must stay untouched. These are the component-side proof that
  each DOM source (`onEditorPaste`'s capture-phase `paste` listener on the editor's parent, vs.
  `onEditorDrop`'s `drop` listener on the Monaco host itself) actually threads the right flag down to
  `insertFilesAsAssets` -- `stores/editor.test.js` covers the naming logic itself directly.
*/
describe('EditorMarkdown paste vs. drop file naming (OpenProject #806 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeFile(name, type = 'image/png') {
    return new File(['x'], name, { type })
  }

  it('mints distinct fileNames for two images pasted in a row, both literally named "image.png"', async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = useEditorStore()
    // -> `pasteCaptureNode` in the component is `monacoRef.value.parentElement`, i.e. this wrapper div
    const editorEl = wrapper.find('.editor-markdown-editor')

    await editorEl.trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], getData: () => '' }
    })
    await editorEl.trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], getData: () => '' }
    })

    expect(editorStore.pendingAssets).toHaveLength(2)
    const [first, second] = editorStore.pendingAssets
    expect(first.fileName).not.toBe('image.png')
    expect(second.fileName).not.toBe('image.png')
    expect(first.fileName).not.toBe(second.fileName)
  })

  it("preserves a dropped file's real name unchanged -- no regression from the paste fix", async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = useEditorStore()
    // -> The `drop` listener is on `monacoRef.value` itself, the inner unclassed div
    const dropTarget = wrapper.find('.editor-markdown-editor div')

    await dropTarget.trigger('drop', {
      dataTransfer: { files: [makeFile('quarterly-report.pdf', 'application/pdf')] },
      clientX: 0,
      clientY: 0
    })

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorStore.pendingAssets[0].fileName).toBe('quarterly-report.pdf')
  })
})

/*
  OpenProject #804 follow-up: `onDividerPointerDown`'s `dragSign` was inverted, so dragging the
  divider toward the preview pane GREW it and dragging away SHRANK it -- backwards in both of the
  two layouts the divider has to handle (normal LTR, where the preview sits to the right of the
  divider, and an RTL mirror, where it sits to the left). These tests stand each layout up with
  mocked `getBoundingClientRect()`s (happy-dom, this workspace's Vitest environment, returns all-zero
  rects otherwise) and drag in both directions, asserting the resulting `--preview-width` moved the
  correct way in each -- rather than only re-asserting the sign formula itself, which would pass
  right back on the pre-fix code if copied from it by mistake.
*/
describe('EditorMarkdown resize divider drag direction (OpenProject #804 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockRect(el, { left, width }) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      width,
      top: 0,
      height: 0,
      right: left + width,
      bottom: 0,
      x: left,
      y: 0,
      toJSON: () => ({})
    })
  }

  /*
    Reads the live width the divider drag writes onto the preview pane's inline style
    (`previewInlineStyle`'s `flex: 0 0 <px>px`). happy-dom's `CSSStyleDeclaration` expands that
    shorthand into `flex-basis` (plus `flex-grow`/`flex-shrink`) when serializing the `style`
    attribute, so read the longhand rather than the shorthand written in the component.
  */
  function previewFlexWidth(preview) {
    const match = preview.attributes('style')?.match(/flex-basis:\s*(\d+(?:\.\d+)?)px/)
    return match ? Number(match[1]) : null
  }

  async function dragDivider(wrapper, { down, move }) {
    const divider = wrapper.find('.editor-markdown-divider')
    await divider.trigger('pointerdown', { clientX: down, pointerId: 1 })
    await divider.trigger('pointermove', { clientX: move, pointerId: 1 })
    return wrapper.find('.editor-markdown-preview')
  }

  /*
    Each assertion mounts its own editor: `state.previewWidth` (and so the pointer-down's own
    `dragStartWidthPx`) carries over from one drag to the next on the same instance, which would make
    a second drag's expected width depend on the first drag's result instead of the fixed 500px rect
    below -- a fresh mount is what keeps each `toBe` an easy, self-contained arithmetic check.
  */
  it('shrinks the preview when dragging toward it, in normal (preview-on-the-right) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    // Normal LTR: preview sits to the right of the divider.
    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // Dragging right -- toward the preview -- should shrink it.
    const updatedPreview = await dragDivider(wrapper, { down: 600, move: 650 })
    expect(previewFlexWidth(updatedPreview)).toBe(450)
  })

  it('grows the preview when dragging away from it, in normal (preview-on-the-right) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // Dragging left -- away from the preview -- should grow it.
    const updatedPreview = await dragDivider(wrapper, { down: 600, move: 550 })
    expect(previewFlexWidth(updatedPreview)).toBe(550)
  })

  it('shrinks the preview when dragging toward it, in RTL-mirrored (preview-on-the-left) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    // RTL mirror: preview sits to the left of the divider.
    mockRect(preview.element, { left: 0, width: 500 })
    mockRect(divider.element, { left: 500, width: 4 })
    mockRect(mid.element, { left: 504, width: 600 })

    // Dragging left -- toward the preview -- should shrink it.
    const updatedPreview = await dragDivider(wrapper, { down: 500, move: 450 })
    expect(previewFlexWidth(updatedPreview)).toBe(450)
  })

  it('grows the preview when dragging away from it, in RTL-mirrored (preview-on-the-left) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    mockRect(preview.element, { left: 0, width: 500 })
    mockRect(divider.element, { left: 500, width: 4 })
    mockRect(mid.element, { left: 504, width: 600 })

    // Dragging right -- away from the preview -- should grow it.
    const updatedPreview = await dragDivider(wrapper, { down: 500, move: 550 })
    expect(previewFlexWidth(updatedPreview)).toBe(550)
  })
})
