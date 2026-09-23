import { vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { useCommonStore } from '@/stores/common'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * `monaco-editor` needs real browser layout/measurement APIs happy-dom does not provide, so
 * mounting the real editor would be testing happy-dom rather than this component's own logic.
 *
 * Unlike the lighter Monaco mocks elsewhere, this model applies edits to a line buffer instead of
 * merely recording them: the failure mode under test is a second edit's range going stale once the
 * first has already changed the document, which a recording-only mock could never catch.
 */
export function createFakeModel(initialValue) {
  let lines = initialValue.split('\n')
  return {
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (lineNumber) => lines[lineNumber - 1] ?? '',
    getLineMaxColumn: (lineNumber) => (lines[lineNumber - 1] ?? '').length + 1,
    getValueInRange(range) {
      const selected = lines.slice(range.startLineNumber - 1, range.endLineNumber)
      if (selected.length === 0) {
        return ''
      }
      if (selected.length === 1) {
        return selected[0].slice(range.startColumn - 1, range.endColumn - 1)
      }
      selected[0] = selected[0].slice(range.startColumn - 1)
      selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.endColumn - 1)
      return selected.join('\n')
    },
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
 * One object rather than module-level `let`s: an importer cannot assign to an imported binding,
 * and several suites set the caret before triggering an action. `disposed` lets `getPosition`
 * return `null` the way real Monaco does once torn down, rather than continuing to answer with the
 * last position.
 */
export const editorState = {
  fakeModel: null,
  cursorPosition: null,
  registeredActions: null,
  contextKeys: {},
  decorationCollections: [],
  disposed: false
}

export const fakeEditor = {
  getModel: vi.fn(() => editorState.fakeModel),
  getValue: vi.fn(() => editorState.fakeModel.getValue()),
  // -> Real Monaco resets the whole model (and its undo stack) on `setValue`; rebuilding it here
  //    reproduces that wholesale replace.
  setValue: vi.fn((value) => {
    editorState.fakeModel = createFakeModel(value)
  }),
  getPosition: vi.fn(() => (editorState.disposed ? null : editorState.cursorPosition)),
  setPosition: vi.fn((pos) => {
    editorState.cursorPosition = pos
  }),
  // -> `continueList` reads the primary selection off this rather than `getPosition`, since it has
  //    to tell a collapsed caret apart from a real selection or a second cursor. A test needing
  //    either overrides the return value directly.
  getSelections: vi.fn(() => [
    {
      startLineNumber: editorState.cursorPosition.lineNumber,
      startColumn: editorState.cursorPosition.column,
      endLineNumber: editorState.cursorPosition.lineNumber,
      endColumn: editorState.cursorPosition.column,
      isEmpty: () => true
    }
  ]),
  // -> `null` exercises `onEditorDrop`'s `if (target?.position)` no-op guard, which is all a
  //    happy-dom drop event needs.
  getTargetAtClientPoint: vi.fn(() => null),
  getSelection: vi.fn(() => fakeEditor.getSelections()[0]),
  createContextKey: vi.fn((key, defaultValue) => {
    editorState.contextKeys[key] = defaultValue
    return {
      set: vi.fn((value) => {
        editorState.contextKeys[key] = value
      }),
      get: () => editorState.contextKeys[key],
      reset: vi.fn(() => {
        editorState.contextKeys[key] = defaultValue
      })
    }
  }),
  createDecorationsCollection: vi.fn((decorations = []) => {
    const collection = {
      ranges: decorations.map((decoration) => decoration.range),
      getRange: vi.fn((index) => collection.ranges[index] ?? null),
      clear: vi.fn(() => {
        collection.ranges = []
      })
    }
    editorState.decorationCollections.push(collection)
    return collection
  }),
  pushUndoStop: vi.fn(),
  executeEdits: vi.fn((_source, edits) => {
    for (const edit of edits) {
      editorState.fakeModel.applyEdit(edit)
    }
  }),
  // -> `continueList`'s fallback re-invokes Monaco's default Enter handling through this, so a test
  //    asserts on the call rather than on model content when nothing list-specific applies.
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
 * A factory rather than a plain object: the mock registry is per test file, so each suite gets its
 * own `vi.fn()` call history. `vi.mock` is hoisted per file and so cannot live in this module --
 * each suite calls it itself and hands it this.
 */
export function monacoMock() {
  return {
    editor: {
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      defineTheme: vi.fn(),
      create: vi.fn((_el, opts) => {
        editorState.fakeModel = createFakeModel(opts.value ?? '')
        editorState.cursorPosition = { lineNumber: editorState.fakeModel.getLineCount(), column: 1 }
        editorState.disposed = false
        editorState.registeredActions = {}
        editorState.contextKeys = {}
        editorState.decorationCollections = []
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

export async function mountEditorMarkdown(EditorMarkdown, initialContent = '', { attachTo } = {}) {
  const { wrapper, pageStore } = mountWithApp(EditorMarkdown, {
    stores: { page: { content: initialContent } },
    ...(attachTo ? { attachTo } : {})
  })

  /*
    `processContent`'s post-render `nextTick` calls `loadBlocks()` for every element matching
    `:not(:defined)`, which under happy-dom includes plain built-in tags. That does a real dynamic
    `import()` of `/_blocks/<tag>.js`, which fails and settles later than a single `flushPromises()`
    tick -- so a still-pending one from an earlier test's mount can resolve mid-way through a later
    test and crash against this module's shared `fakeEditor` (`getPosition()` is `null` once any test
    has disposed it), as an unhandled rejection unrelated to what that test asserts.
  */
  useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)

  // -> `onMounted` is async: it awaits before creating the editor.
  await flushPromises()

  return { wrapper, pageStore }
}

/*
  The Insert Footnote toolbar button carries no `aria-label`, so it is found by its `icon` prop,
  which is unique among the sidebar buttons.
*/
export async function clickInsertFootnote(wrapper) {
  const button = wrapper
    .findAllComponents(WBtn)
    .find((candidate) => candidate.props('icon') === 'tabler:book-upload')
  await button.trigger('click')
}

/*
  happy-dom normalises the `flex` shorthand into its longhands when serializing the `style`
  attribute, so read `flex-basis` rather than the shorthand the component writes.
*/
export function previewFlexWidth(preview) {
  const match = preview.attributes('style')?.match(/flex-basis:\s*(\d+(?:\.\d+)?)px/)
  return match ? Number(match[1]) : null
}
