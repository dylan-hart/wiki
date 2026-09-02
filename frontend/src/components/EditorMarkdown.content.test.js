import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editor'
import {
  clickInsertFootnote,
  editorState,
  fakeEditor,
  mountEditorMarkdown
} from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

describe('EditorMarkdown insertFootnote (OpenProject #803)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inserts a marker inline and an appended note when the cursor is mid-document', async () => {
    const { wrapper } = await mountEditor('Line one.\nLine two.')
    editorState.cursorPosition = { lineNumber: 1, column: 5 }

    await clickInsertFootnote(wrapper)

    expect(editorState.fakeModel.getValue()).toBe('Line[^1] one.\nLine two.\n\n[^1]: ')
  })

  it('separates marker and note on a document that starts completely empty', async () => {
    const { wrapper } = await mountEditor('')
    editorState.cursorPosition = { lineNumber: 1, column: 1 }

    await clickInsertFootnote(wrapper)

    // -> The cursor is trivially "at the document end" here too (an empty document has nowhere
    //    else for it to be), which collided the two edit ranges pre-fix the same as the non-empty
    //    case above.
    expect(editorState.fakeModel.getValue()).toBe('[^1]\n\n[^1]: ')
  })

  it('inserts a marker and a separately-delimited note when the cursor is at the document end', async () => {
    const { wrapper } = await mountEditor('Some text.')
    // -> Cursor already at the exact end of the document, the same state a real editor is left in
    //    right after a previous footnote insertion -- and the state that collapsed the two edit
    //    ranges together before this fix.
    editorState.cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

    await clickInsertFootnote(wrapper)

    expect(editorState.fakeModel.getValue()).toBe('Some text.[^1]\n\n[^1]: ')
  })

  it('keeps marker and note separated across two footnote insertions with no cursor movement between them', async () => {
    const { wrapper } = await mountEditor('Some text.')
    editorState.cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

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

    const value = editorState.fakeModel.getValue()
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
    editorState.fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'PASTED '
    })
    expect(pageStore.content).not.toContain('PASTED')

    editorStore.contentFlusher()

    expect(pageStore.content).toBe(editorState.fakeModel.getValue())
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

describe('EditorMarkdown list continuation on Enter (OpenProject #802)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function pressEnter() {
    editorState.registeredActions['markdown.extension.editing.continueList'].run()
  }

  it('falls back to default Enter handling on a plain, non-list line', async () => {
    await mountEditor('Some text.')
    editorState.cursorPosition = { lineNumber: 1, column: 'Some text.'.length + 1 }

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
    expect(editorState.fakeModel.getValue()).toBe('Some text.')
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
    editorState.cursorPosition = { lineNumber: 1, column: 1 }

    pressEnter()

    expect(fakeEditor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
    expect(editorState.fakeModel.getValue()).toBe('- one')
  })

  it('continues an unordered list item', async () => {
    await mountEditor('- one')
    editorState.cursorPosition = { lineNumber: 1, column: '- one'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- one\n- ')
    expect(fakeEditor.trigger).not.toHaveBeenCalled()
  })

  it('continues an ordered list item, incrementing the number', async () => {
    await mountEditor('1. one')
    editorState.cursorPosition = { lineNumber: 1, column: '1. one'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('1. one\n2. ')
  })

  it('preserves the ")" delimiter on an ordered list item', async () => {
    await mountEditor('1) one')
    editorState.cursorPosition = { lineNumber: 1, column: '1) one'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('1) one\n2) ')
  })

  it('preserves the "*" bullet character on an unordered list item', async () => {
    await mountEditor('* one')
    editorState.cursorPosition = { lineNumber: 1, column: '* one'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('* one\n* ')
  })

  it('registers the continue-list action on Enter with the expected precondition', async () => {
    await mountEditor('')

    const action = editorState.registeredActions['markdown.extension.editing.continueList']

    expect(action.keybindings).toContain(6)
    expect(action.precondition).toBe(
      'editorTextFocus && !suggestWidgetVisible && !renameInputVisible'
    )
  })

  it('continues a task list item as unchecked, from a checked previous item', async () => {
    await mountEditor('- [x] done')
    editorState.cursorPosition = { lineNumber: 1, column: '- [x] done'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- [x] done\n- [ ] ')
  })

  it('continues a task list item as unchecked, from an unchecked previous item', async () => {
    await mountEditor('- [ ] todo')
    editorState.cursorPosition = { lineNumber: 1, column: '- [ ] todo'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- [ ] todo\n- [ ] ')
  })

  it('preserves indentation for a nested list item', async () => {
    await mountEditor('  - nested')
    editorState.cursorPosition = { lineNumber: 1, column: '  - nested'.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('  - nested\n  - ')
  })

  it('splits mid-line, prefixing the moved text on the new line', async () => {
    await mountEditor('- one two')
    editorState.cursorPosition = { lineNumber: 1, column: '- one '.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- one \n- two')
  })

  it('exits an unordered list on an empty item', async () => {
    await mountEditor('- one\n- ')
    editorState.cursorPosition = { lineNumber: 2, column: '- '.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- one\n')
    expect(fakeEditor.trigger).not.toHaveBeenCalled()
  })

  it('exits an ordered list on an empty item', async () => {
    await mountEditor('1. one\n2. ')
    editorState.cursorPosition = { lineNumber: 2, column: '2. '.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('1. one\n')
  })

  it('exits a task list on an empty item', async () => {
    await mountEditor('- [ ] one\n- [ ] ')
    editorState.cursorPosition = { lineNumber: 2, column: '- [ ] '.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- [ ] one\n')
  })

  it('exits an indented, empty list item', async () => {
    await mountEditor('- one\n  - ')
    editorState.cursorPosition = { lineNumber: 2, column: '  - '.length + 1 }

    pressEnter()

    expect(editorState.fakeModel.getValue()).toBe('- one\n')
  })
})
