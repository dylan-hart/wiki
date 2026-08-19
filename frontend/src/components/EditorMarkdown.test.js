import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import { usePageStore } from '@/stores/page'
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
  getPosition: vi.fn(() => cursorPosition),
  setPosition: vi.fn((pos) => {
    cursorPosition = pos
  }),
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
