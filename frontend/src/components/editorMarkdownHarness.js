import { vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { useCommonStore } from '@/stores/common'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * The Monaco stand-in and mount helper `EditorMarkdown.vue`'s five suites share, lifted out of the
 * single 995-line `EditorMarkdown.test.js` when it was split by concern (TEST-F14).
 *
 * A sibling module rather than a `*.test.js`, matching `graphFixtures.js` under `pages/`:
 * `vitest.config.js` only collects `*.test.js`, so this is imported, never run as a suite of its
 * own. Each suite still calls `vi.mock('monaco-editor', ...)` itself -- `vi.mock` is hoisted per
 * file and cannot be moved into an imported module -- and hands it `monacoMock()` from here, so all
 * five mock the same surface with their own independent call history.
 *
 * `EditorMarkdown.collab.test.js` deliberately keeps its own, much lighter Monaco mock: it asserts
 * on `updateOptions` alone and mocks `@/composables/collab` besides, so the full model-applying fake
 * below would be more machinery than that suite is testing.
 */

/**
 * `monaco-editor` needs real browser layout/measurement APIs that `happy-dom` (this workspace's
 * Vitest environment, see `vitest.config.js`) does not provide, so mounting the real editor here
 * would be testing whether happy-dom can pretend to be a browser, not this component's own logic.
 * Mocked to the handful of calls `EditorMarkdown.vue` actually makes at mount time -- the same
 * reused boot pattern `EditorCode.test.js` documents and relies on.
 *
 * Unlike that lighter mock, the model here actually applies edits to a line buffer rather than merely
 * recording them: the bug under test (OpenProject #803) is specifically about the SECOND
 * edit's range going stale once the FIRST edit has already changed the document, which a mock that
 * only records `executeEdits` calls without applying them could never catch.
 */
export function createFakeModel(initialValue) {
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

/**
 * The fake editor's mutable state, as one object rather than four module-level `let`s: an importer
 * cannot assign to an imported binding, and several suites set the caret before triggering an
 * action. `editorState.disposed` lets `getPosition` reproduce what real Monaco does once torn down
 * (OpenProject #808): it returns `null` rather than continuing to answer with the last position.
 */
export const editorState = {
  fakeModel: null,
  cursorPosition: null,
  registeredActions: null,
  disposed: false
}

export const fakeEditor = {
  getModel: vi.fn(() => editorState.fakeModel),
  getValue: vi.fn(() => editorState.fakeModel.getValue()),
  // -> Real Monaco resets the whole model (and its undo stack) on `setValue`; rebuilding the model
  //    from scratch reproduces that "wholesale replace" shape.
  setValue: vi.fn((value) => {
    editorState.fakeModel = createFakeModel(value)
  }),
  getPosition: vi.fn(() => (editorState.disposed ? null : editorState.cursorPosition)),
  setPosition: vi.fn((pos) => {
    editorState.cursorPosition = pos
  }),
  // -> `continueList` (OpenProject #802) reads the primary selection off this rather than
  //    `getPosition`, since it needs to tell a collapsed caret apart from a real selection or a
  //    second cursor. Defaults to a single collapsed selection at the current caret; tests that need
  //    a real selection or multiple cursors override the return value directly.
  getSelections: vi.fn(() => [
    {
      startLineNumber: editorState.cursorPosition.lineNumber,
      startColumn: editorState.cursorPosition.column,
      endLineNumber: editorState.cursorPosition.lineNumber,
      endColumn: editorState.cursorPosition.column,
      isEmpty: () => true
    }
  ]),
  // -> Only consulted by `onEditorDrop` to move the cursor to the drop point; `null` exercises its
  //    `if (target?.position)` no-op guard, which is all a happy-dom drop event needs here.
  getTargetAtClientPoint: vi.fn(() => null),
  executeEdits: vi.fn((_source, edits) => {
    for (const edit of edits) {
      editorState.fakeModel.applyEdit(edit)
    }
  }),
  // -> `continueList`'s fallback path re-invokes Monaco's own default Enter handling this way;
  //    tests assert on this call rather than on model content when nothing list-specific applies.
  trigger: vi.fn(),
  updateOptions: vi.fn(),
  addCommand: vi.fn(() => 'fake-command-id'),
  addAction: vi.fn((config) => {
    editorState.registeredActions[config.id] = config
    return { dispose: vi.fn() }
  }),
  onDidChangeModelContent: vi.fn(),
  onDidChangeCursorPosition: vi.fn(),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(() => {
    editorState.disposed = true
  })
}

/**
 * What each suite hands `vi.mock('monaco-editor', ...)`. A factory rather than a plain object: the
 * mock registry is per test file, so every suite gets its own `vi.fn()` call history.
 */
export function monacoMock() {
  return {
    editor: {
      defineTheme: vi.fn(),
      create: vi.fn((_el, opts) => {
        editorState.fakeModel = createFakeModel(opts.value ?? '')
        editorState.cursorPosition = { lineNumber: editorState.fakeModel.getLineCount(), column: 1 }
        editorState.disposed = false
        editorState.registeredActions = {}
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
  }
}

export async function mountEditorMarkdown(EditorMarkdown, initialContent = '') {
  const { wrapper, pageStore } = mountWithApp(EditorMarkdown, {
    stores: { page: { content: initialContent } }
  })

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
    Stubbed here, for every mount through this helper, to keep each test deterministic and self-contained.
  */
  useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)

  // -> `onMounted` is async (awaits `loadSiteBlocks`/`fetchUserSettings` before creating the editor)
  await flushPromises()

  return { wrapper, pageStore }
}

/*
  The Insert Footnote toolbar button carries no `aria-label` of its own (unlike, say,
  `EditorCode.vue`'s equivalent), so it can't be found by that selector -- its `icon` prop is unique
  among the sidebar buttons instead.
*/
export async function clickInsertFootnote(wrapper) {
  const button = wrapper
    .findAllComponents(WBtn)
    .find((candidate) => candidate.props('icon') === 'mdi:book-plus')
  await button.trigger('click')
}

/*
  Reads the preview pane's resolved width back off the DOM. happy-dom normalises the `flex`
  shorthand into `flex-basis` (plus `flex-grow`/`flex-shrink`) when serializing the `style`
  attribute, so read the longhand rather than the shorthand written in the component. Lives here
  because the preview and resize shards both assert on it.
*/
export function previewFlexWidth(preview) {
  const match = preview.attributes('style')?.match(/flex-basis:\s*(\d+(?:\.\d+)?)px/)
  return match ? Number(match[1]) : null
}
