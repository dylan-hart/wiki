import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from '@/stores/page'
import { useEditorStore } from '@/stores/editor'
import { useCommonStore } from '@/stores/common'
import WBtn from '@/components/shared/WBtn.vue'

import { createTestI18n } from '../../test/i18n.js'

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
let registeredActions
/**
 * Whether `fakeEditor.dispose()` has been called -- lets `getPosition` reproduce the real Monaco
 * behaviour a disposed editor exhibits (`OpenProject #808`): `getPosition()` returns `null` once the
 * editor is torn down, rather than continuing to answer with the last known position.
 */
let disposed
const fakeEditor = {
  getModel: vi.fn(() => fakeModel),
  getValue: vi.fn(() => fakeModel.getValue()),
  // -> Real Monaco resets the whole model (and its undo stack) on `setValue`; rebuilding `fakeModel`
  //    from scratch reproduces that "wholesale replace" shape.
  setValue: vi.fn((value) => {
    fakeModel = createFakeModel(value)
  }),
  getPosition: vi.fn(() => (disposed ? null : cursorPosition)),
  setPosition: vi.fn((pos) => {
    cursorPosition = pos
  }),
  // -> `continueList` (OpenProject #802) reads the primary selection off this rather than
  //    `getPosition`, since it needs to tell a collapsed caret apart from a real selection or a
  //    second cursor. Defaults to a single collapsed selection at `cursorPosition`; tests that need
  //    a real selection or multiple cursors override the return value directly.
  getSelections: vi.fn(() => [
    {
      startLineNumber: cursorPosition.lineNumber,
      startColumn: cursorPosition.column,
      endLineNumber: cursorPosition.lineNumber,
      endColumn: cursorPosition.column,
      isEmpty: () => true
    }
  ]),
  // -> Only consulted by `onEditorDrop` to move the cursor to the drop point; `null` exercises its
  //    `if (target?.position)` no-op guard, which is all a happy-dom drop event needs here.
  getTargetAtClientPoint: vi.fn(() => null),
  executeEdits: vi.fn((_source, edits) => {
    for (const edit of edits) {
      fakeModel.applyEdit(edit)
    }
  }),
  // -> `continueList`'s fallback path re-invokes Monaco's own default Enter handling this way;
  //    tests assert on this call rather than on model content when nothing list-specific applies.
  trigger: vi.fn(),
  updateOptions: vi.fn(),
  addCommand: vi.fn(() => 'fake-command-id'),
  addAction: vi.fn((config) => {
    registeredActions[config.id] = config
    return { dispose: vi.fn() }
  }),
  onDidChangeModelContent: vi.fn(),
  onDidChangeCursorPosition: vi.fn(),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(() => {
    disposed = true
  })
}

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn((_el, opts) => {
      fakeModel = createFakeModel(opts.value ?? '')
      cursorPosition = { lineNumber: fakeModel.getLineCount(), column: 1 }
      disposed = false
      registeredActions = {}
      return fakeEditor
    })
  },
  languages: {
    setLanguageConfiguration: vi.fn(),
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() }))
  },
  KeyMod: { CtrlCmd: 1, Alt: 2 },
  KeyCode: { KeyB: 1, KeyI: 2, KeyS: 3, RightArrow: 4, LeftArrow: 5, Enter: 6 },
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

  /*
    `processContent`'s post-render `nextTick` calls `commonStore.loadBlocks()` for every element the
    rendered preview's `:not(:defined)` matches -- which, under happy-dom, includes plain built-in
    tags like `<p>`, not just actual custom elements. That action does a real dynamic `import()` of
    `/_blocks/<tag>.js`, which happy-dom/Vitest genuinely attempts to resolve and fails -- settling
    later than a single `flushPromises()` tick. Left un-stubbed, a still-pending one of these from an
    earlier, never-unmounted test's mount can resolve mid-way through a LATER test, call
    `syncPreviewTabs()` against this file's shared `fakeEditor` singleton, and throw the exact
    OpenProject #808 crash (`getPosition()` returns `null` once ANY test has disposed the shared
    editor) as an unhandled rejection unrelated to whatever that later test is actually asserting.
    Stubbed here, for every mount in this file, to keep each test deterministic and self-contained.
  */
  useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)

  const i18n = createTestI18n()

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
  OpenProject #1889: `flushEditorContent()` used to call `processContent(value)` unconditionally on
  every 500ms debounced edit -- running the full markdown-it + KaTeX + highlight.js pipeline over the
  whole document and immediately discarding the result whenever there was no preview pane open to show
  it. These are the fix's three verification points: a closed-pane debounced flush skips the renderer
  entirely (while still syncing `pageStore.content`, so a save is never reading stale text), reopening
  the pane catches up the pending render, and the save-path flusher (`editorStore.contentFlusher`, now
  `flushEditorContentForSave`) still renders a stale document before `pageStore.pageSave()` reads
  `render` -- see that call site in `stores/page.js`.
*/
describe('EditorMarkdown skips rendering while the preview pane is closed (OpenProject #1889)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function closePreview(wrapper) {
    const hideButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:eye-off-outline')
    await hideButton.trigger('click')
  }

  it('does not run the renderer on a debounced edit while the pane is closed', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    await closePreview(wrapper)
    // -> `md` is only assigned once `onMounted` resolves (see `mountEditor`'s own comment on why this
    //    test file mounts the real markdown pipeline rather than stubbing it out)
    const renderSpy = vi.spyOn(wrapper.vm.md, 'render')

    fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'EDITED '
    })
    // -> The handler `onDidChangeModelContent` was registered with -- same as the OpenProject #808
    //    tests above use to arm the debounce
    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({})
    vi.advanceTimersByTime(500)

    // -> Content still syncs on every debounced edit -- a save must never read stale `content`
    expect(pageStore.content).toContain('EDITED')
    // -> But the render pipeline itself never ran, and the flag records the render this owes
    expect(renderSpy).not.toHaveBeenCalled()
    expect(wrapper.vm.state.renderIsStale).toBe(true)
  })

  it('renders the pending content once the preview pane is reopened', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    await closePreview(wrapper)

    fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'EDITED '
    })
    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({})
    vi.advanceTimersByTime(500)
    expect(wrapper.vm.state.renderIsStale).toBe(true)

    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')

    expect(pageStore.render).toContain('EDITED')
    expect(wrapper.vm.state.renderIsStale).toBe(false)
  })

  it('the save-path flusher renders a stale document before pageSave reads pageStore.render', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    const editorStore = useEditorStore()
    await closePreview(wrapper)
    const renderBeforeEdit = pageStore.render

    fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'SAVE-PATH-EDIT '
    })

    // -> What `pageStore.pageSave()` calls synchronously before it reads `render` -- proves the save
    //    path renders even with nothing yet flushed through the debounced handler: the flusher itself
    //    both syncs `content` from the live editor value and, because the pane is closed, catches up
    //    the render too -- unlike the plain debounced flush the first test above covers.
    editorStore.contentFlusher()

    expect(pageStore.content).toContain('SAVE-PATH-EDIT')
    expect(pageStore.render).not.toBe(renderBeforeEdit)
    expect(pageStore.render).toContain('SAVE-PATH-EDIT')
    expect(wrapper.vm.state.renderIsStale).toBe(false)
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

describe('EditorMarkdown resize divider drag direction (OpenProject #804 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

/*
  OpenProject #809: dragging the divider down past `PREVIEW_HIDE_THRESHOLD_PX` used to leave
  `state.previewWidth` at the tiny in-drag value for the whole close animation, only restoring the
  real pre-drag width in `onPreviewAfterLeave` -- after the pane had already finished animating shut,
  so the fix was invisible until the next open. `onDividerPointerUp` now commits the restore
  synchronously, before the close even begins.
  happy-dom implements no real CSS transitions (`getComputedStyle` reports no transition-duration),
  so the leaving element is torn down immediately rather than lingering through a `leave-active`
  state -- there is no way to assert on the pane's rendered width *during* the close animation here.
  What IS asserted, without needing a live browser: the DATA the animation would read from is correct
  by the time the pane starts leaving, proven the same way `onPreviewAfterLeave` used to prove its own
  restore worked -- reopening afterwards lands back at the pre-drag width, not the near-zero one the
  drag ended on. Whether the animation itself visually covers the right distance, with no earlier pop,
  is a live-browser concern outside what this suite can see.
*/
describe('EditorMarkdown drag-to-hide restores the pre-drag width (OpenProject #809)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reopens at the width the pane had before the hide-drag, not the width the drag ended on', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    let divider = wrapper.find('.editor-markdown-divider')
    let preview = wrapper.find('.editor-markdown-preview')

    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // First drag: settle the pane at a known, deliberately-large width and release ABOVE the hide
    // threshold, so it persists as `state.previewWidth` -- this is the "actual set width" the
    // second drag below must be judged against.
    preview = await dragDivider(wrapper, { down: 600, move: 650 })
    await divider.trigger('pointerup', { clientX: 650, pointerId: 1 })
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)

    // Second drag: well past `PREVIEW_HIDE_THRESHOLD_PX` (100), all the way down to a sliver --
    // the drag-to-hide path.
    divider = wrapper.find('.editor-markdown-divider')
    preview = await dragDivider(wrapper, { down: 600, move: 1000 })
    expect(previewFlexWidth(preview)).toBeLessThan(100)
    await divider.trigger('pointerup', { clientX: 1000, pointerId: 1 })

    // The pane is gone -- happy-dom's leave completes immediately with no real transition to wait on.
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)

    // Reopen via the toolbar's own show button. Pre-fix, this came back at whatever the drag left
    // `state.previewWidth` on (~near zero); it must instead come back at the 450px the pane actually
    // had set before this second drag started.
    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')

    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)
  })
})

/*
  OpenProject #809 follow-up: `previewShown` used to start `true` (on a wide-enough viewport) before
  `onMounted` had this user's saved width back from the async settings fetch -- so the pane appeared
  instantly at the SCSS fallback (`50vw`) and snapped to the real width a moment later, rather than
  never appearing at the wrong width at all. `previewShown` now starts `false` unconditionally, and
  only opens (if it opens) once `previewWidth` is already resolved too, so the pane's one entrance this
  mount picks up the correct width from its very first frame. `previewEverRevealed` is what lets that
  first entrance use a distinct, faster transition (matching the side nav's own `0.2s` close) without
  changing the toggle-button transition a reader triggers later.
*/
describe('EditorMarkdown preview pane initial reveal (OpenProject #809 follow-up)', () => {
  it('does not start with the preview already shown -- it opens only once mount has resolved', () => {
    setActivePinia(createPinia())
    useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)
    const i18n = createTestI18n()

    const wrapper = mount(EditorMarkdown, { global: { plugins: [i18n] } })

    // -> Synchronously, before `onMounted`'s awaited settings fetch has had any chance to resolve.
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)
    expect(wrapper.vm.previewEverRevealed).toBe(false)
  })

  it('marks the pane as having revealed once mount settles, and keeps it marked across a later toggle', async () => {
    const { wrapper } = await mountEditor('Some text.')

    // -> The one entrance this mount has already happened by the time `mountEditor` returns (it awaits
    //    `flushPromises`, which settles the `nextTick` this flag is set in) -- so it reads `true` here,
    //    not because this test caught it mid-animation.
    expect(wrapper.vm.previewEverRevealed).toBe(true)
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(true)

    // -> Hide and reshow via the toolbar buttons. This is the toggle-button path the ORIGINAL
    //    `editor-markdown-preview` transition (unchanged, 0.5s) still owns -- proving the flag does not
    //    reset is what proves this fix cannot regress that already-verified behavior.
    const hideButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:eye-off-outline')
    await hideButton.trigger('click')
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)
    expect(wrapper.vm.previewEverRevealed).toBe(true)

    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(true)
    expect(wrapper.vm.previewEverRevealed).toBe(true)
  })

  it("uses App.vue's prefetched settings instead of fetching again, when already cached", async () => {
    setActivePinia(createPinia())
    const editorStore = useEditorStore()
    useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)
    // -> Standing in for App.vue's own prefetch (OpenProject #809 follow-up) having already landed by
    //    the time this component mounts -- the normal case, not a special setup for this test alone.
    editorStore.userSettings.markdown = { previewShown: true, previewWidth: 725 }
    const fetchUserSettings = vi.spyOn(editorStore, 'fetchUserSettings')
    const i18n = createTestI18n()

    const wrapper = mount(EditorMarkdown, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(fetchUserSettings).not.toHaveBeenCalled()
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(725)
  })

  it('falls back to fetching directly when nothing was prefetched (e.g. a guest who just signed in)', async () => {
    setActivePinia(createPinia())
    const editorStore = useEditorStore()
    useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)
    const fetchUserSettings = vi
      .spyOn(editorStore, 'fetchUserSettings')
      .mockResolvedValue({ previewShown: true, previewWidth: 725 })
    const i18n = createTestI18n()

    const wrapper = mount(EditorMarkdown, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(fetchUserSettings).toHaveBeenCalledWith('markdown')
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(725)
  })
})

/*
  OpenProject #808: both `onDidChangeModelContent` and `onDidChangeCursorPosition` are registered
  wrapped in a 500ms `debounce()`, with no reference kept to cancel either. `onBeforeUnmount` disposes
  the editor but, pre-fix, left any pending debounced call armed -- it fired ~500ms later against the
  now-disposed editor, and the cursor handler's `editor.getPosition().lineNumber` crashed because a
  disposed Monaco editor's `getPosition()` returns `null` (reproduced by `fakeEditor.getPosition`
  above via the `disposed` flag `dispose()` sets).
*/
describe('EditorMarkdown debounced handler cleanup on unmount (OpenProject #808)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a pending cursor-position debounce on unmount, so it never fires against the disposed editor', async () => {
    const { wrapper } = await mountEditor('Line one.\nLine two.\nLine three.')

    // -> The handler `onDidChangeCursorPosition` was registered with -- the debounced wrapper itself,
    //    same as a real Monaco `onDidChangeCursorPosition(cb)` call would invoke on every move.
    const cursorPositionHandler = fakeEditor.onDidChangeCursorPosition.mock.calls[0][0]
    cursorPositionHandler({}) // -> arms the 500ms debounce, same as an author moving the caret

    // -> Mount itself already called `getPosition()` once (the initial preview-tab sync) -- captured
    //    here so the assertion below is about calls from AFTER unmount, not this legitimate earlier one.
    const getPositionCallsAtUnmount = fakeEditor.getPosition.mock.calls.length
    wrapper.unmount()

    // -> Pre-fix, this throws: the debounce fires here, `getPosition()` returns `null` (disposed),
    //    and reading `.lineNumber` off it throws "Cannot read properties of null (reading
    //    'lineNumber')" -- the exact crash from the ticket.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> Confirms *why* it didn't throw: the debounced call was cancelled, not merely lucky timing --
    //    no NEW call to `getPosition()` happened once the timer was advanced.
    expect(fakeEditor.getPosition.mock.calls.length).toBe(getPositionCallsAtUnmount)
  })

  it('cancels a pending content-change debounce on unmount, so it never re-reads the disposed editor', async () => {
    const { wrapper } = await mountEditor('Line one.')

    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({}) // -> arms the 500ms debounce, same as an author typing a keystroke

    // -> `flushEditorContent` (what the debounced handler calls) reads `editor.getValue()` -- captured
    //    here the same way `getPositionCallsAtUnmount` is above, so the assertion below is about calls
    //    from AFTER unmount, not any legitimate earlier one.
    const getValueCallsAtUnmount = fakeEditor.getValue.mock.calls.length
    wrapper.unmount()

    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> Pre-fix, this call count DOES advance: the debounce still fires post-dispose and re-reads
    //    `editor.getValue()`, which is the other half of the ticket's "leaves a blank page until
    //    refresh" symptom -- a disposed Monaco editor's `getValue()` no longer reflects the document,
    //    so that stale/empty read would land straight in `pageStore.content`.
    expect(fakeEditor.getValue.mock.calls.length).toBe(getValueCallsAtUnmount)
  })
})

describe('EditorMarkdown list continuation on Enter (OpenProject #802)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function pressEnter() {
    registeredActions['markdown.extension.editing.continueList'].run()
  }

  it('falls back to default Enter handling on a plain, non-list line', async () => {
    await mountEditor('Some text.')
    cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
    expect(fakeModel.getValue()).toBe('Some text.')
  })

  it('falls back when there are multiple cursors', async () => {
    await mountEditor('- one\n- two')
    fakeEditor.getSelections.mockReturnValueOnce([
      { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6, isEmpty: () => true },
      { startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 6, isEmpty: () => true }
    ])

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
  })

  it('falls back when the cursor has a non-empty selection', async () => {
    await mountEditor('- one')
    fakeEditor.getSelections.mockReturnValueOnce([
      { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6, isEmpty: () => false }
    ])

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
  })

  it('falls back when the cursor is positioned before the end of the marker', async () => {
    await mountEditor('- one')
    cursorPosition = { lineNumber: 1, column: 1 }

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
    expect(fakeModel.getValue()).toBe('- one')
  })

  it('continues an unordered list item', async () => {
    await mountEditor('- one')
    cursorPosition = { lineNumber: 1, column: '- one'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- one\n- ')
    expect(fakeEditor.trigger).not.toHaveBeenCalled()
  })

  it('continues an ordered list item, incrementing the number', async () => {
    await mountEditor('1. one')
    cursorPosition = { lineNumber: 1, column: '1. one'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('1. one\n2. ')
  })

  it('preserves the ")" delimiter on an ordered list item', async () => {
    await mountEditor('1) one')
    cursorPosition = { lineNumber: 1, column: '1) one'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('1) one\n2) ')
  })

  it('preserves the "*" bullet character on an unordered list item', async () => {
    await mountEditor('* one')
    cursorPosition = { lineNumber: 1, column: '* one'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('* one\n* ')
  })

  it('registers the continue-list action on Enter with the expected precondition', async () => {
    await mountEditor('')

    const action = registeredActions['markdown.extension.editing.continueList']

    expect(action.keybindings).toContain(6)
    expect(action.precondition).toBe(
      'editorTextFocus && !suggestWidgetVisible && !renameInputVisible'
    )
  })

  it('continues a task list item as unchecked, from a checked previous item', async () => {
    await mountEditor('- [x] done')
    cursorPosition = { lineNumber: 1, column: '- [x] done'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- [x] done\n- [ ] ')
  })

  it('continues a task list item as unchecked, from an unchecked previous item', async () => {
    await mountEditor('- [ ] todo')
    cursorPosition = { lineNumber: 1, column: '- [ ] todo'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- [ ] todo\n- [ ] ')
  })

  it('preserves indentation for a nested list item', async () => {
    await mountEditor('  - nested')
    cursorPosition = { lineNumber: 1, column: '  - nested'.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('  - nested\n  - ')
  })

  it('splits mid-line, prefixing the moved text on the new line', async () => {
    await mountEditor('- one two')
    cursorPosition = { lineNumber: 1, column: '- one '.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- one \n- two')
  })

  it('exits an unordered list on an empty item', async () => {
    await mountEditor('- one\n- ')
    cursorPosition = { lineNumber: 2, column: '- '.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- one\n')
    expect(fakeEditor.trigger).not.toHaveBeenCalled()
  })

  it('exits an ordered list on an empty item', async () => {
    await mountEditor('1. one\n2. ')
    cursorPosition = { lineNumber: 2, column: '2. '.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('1. one\n')
  })

  it('exits a task list on an empty item', async () => {
    await mountEditor('- [ ] one\n- [ ] ')
    cursorPosition = { lineNumber: 2, column: '- [ ] '.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- [ ] one\n')
  })

  it('exits an indented, empty list item', async () => {
    await mountEditor('- one\n  - ')
    cursorPosition = { lineNumber: 2, column: '  - '.length + 1 }

    pressEnter()

    expect(fakeModel.getValue()).toBe('- one\n')
  })
})

/*
 * Mount-time `editor.focus()` (`// -> Post init`) used to run unconditionally, which raced an
 * author who clicked into the page Title field (`PageHeader.vue`'s contenteditable -- it has no
 * autofocus of its own) and started typing before Monaco's async `onMounted` -- it awaits a
 * settings/site-blocks prefetch before ever creating the editor -- had finished: the moment Monaco
 * mounted, its focus() call stole focus mid-type, and every keystroke meant for the title landed in
 * the editor instead, leaving the title empty. Caught by the Playwright smoke suite's
 * `page-publish.spec.js`, which types the title and blurs it well before this component's async
 * mount settles on a loaded CI runner.
 */
describe('EditorMarkdown does not steal focus already given to another field on mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses itself when nothing else has focus yet, matching the previous default', async () => {
    const { wrapper } = await mountEditor('')
    expect(fakeEditor.focus).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('leaves focus alone when another field was already focused before mount finished', async () => {
    const titleInput = document.createElement('input')
    document.body.appendChild(titleInput)
    titleInput.focus()

    const { wrapper } = await mountEditor('')

    expect(fakeEditor.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(titleInput)
    wrapper.unmount()
  })
})
