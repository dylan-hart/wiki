# Markdown Editor List Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing Enter inside an unordered, ordered, or task list in the Markdown editor continues the list (auto-numbering for ordered lists, preserving indentation) and exits the list when pressed on an already-empty item, instead of producing a plain line.

**Architecture:** A new `continueList()` function in `EditorMarkdown.vue`, registered as a Monaco editor action bound to the `Enter` key. It classifies the current line (task / ordered / unordered / not-a-list) via three regexes, then either edits the model to continue the list, edits it to exit the list, or falls back to Monaco's own default Enter handling (`editor.trigger('keyboard', 'type', { text: '\n' })`) for every case outside that.

**Tech Stack:** Vue 3 `<script setup>`, `monaco-editor`, Vitest + `@vue/test-utils` (existing `EditorMarkdown.test.js` mock of `monaco-editor`).

**Spec:** `docs/superpowers/specs/2026-08-20-markdown-editor-list-continuation-design.md`

## Global Constraints

- Format with oxfmt conventions already in force in this file: no semicolons, single quotes, no trailing commas, 2-space indent. Run `npx oxfmt src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js` from `frontend/` after each task's edits.
- Lint clean: `npx oxlint` from `frontend/` must report no `correctness`-category errors on touched files.
- No new comments explaining *what* code does — only the existing file's `// ->` convention for a non-obvious *why* (see the cursor-before-marker guard in Task 2, which needs one).
- Test file stays co-located: all new tests go in `frontend/src/components/EditorMarkdown.test.js`, following its existing `describe('EditorMarkdown <feature> (OpenProject #NNN)', ...)` convention — use `(OpenProject #802)`.
- Run only the scoped test file while iterating, never the full suite: `npx vitest run src/components/EditorMarkdown.test.js` from `frontend/`.
- Reuse the file's existing `mountEditor()` helper and `fakeEditor`/`fakeModel`/`cursorPosition` module-level mock state — do not introduce a second mocking strategy.
- The Monaco action's `precondition` must be `'editorTextFocus && !suggestWidgetVisible && !renameInputVisible'` (per the spec's Architecture section) — not the `precondition: ''` used by this file's other `editor.addAction` calls. Those are safe to fire unconditionally (Ctrl+B, arrow-key header level); binding the bare `Enter` key is not, since it must not steal Enter from Monaco's own autocomplete-accept or rename-in-progress UI.

---

## Task 1: Test harness extensions + Monaco action wiring (fallback-only)

**Files:**
- Modify: `frontend/src/components/EditorMarkdown.test.js:48-121` (the `fakeEditor` object and `vi.mock('monaco-editor', ...)` factory)
- Modify: `frontend/src/components/EditorMarkdown.vue:1078` (add `continueList`/`fallbackToDefaultEnter` above `insertBeforeEachLine`, wire the action in the mounted setup near the other `editor.addAction` calls at ~line 1866)

**Interfaces:**
- Produces: `continueList()` (for this task, unconditionally calls `fallbackToDefaultEnter()`), `fallbackToDefaultEnter()` — both plain functions inside `EditorMarkdown.vue`'s `<script setup>`, no exports (matches how `insertBeforeEachLine` is already tested only indirectly, through the mounted component).
- Produces (test harness): module-level `registeredActions` object in the test file, reset on every `editor.create()` call, holding every action config passed to `fakeEditor.addAction` keyed by `id`. `fakeEditor.getSelections` and `fakeEditor.trigger` mocks.
- Consumes: existing `fakeModel`, `cursorPosition`, `mountEditor()` from the test file.

- [ ] **Step 1: Extend the `fakeEditor` mock with `getSelections`, `trigger`, and action-capturing `addAction`**

In `frontend/src/components/EditorMarkdown.test.js`, add a module-level `let registeredActions` next to the existing `let fakeModel` / `let cursorPosition` / `let disposed` declarations (around line 48-55):

```js
let fakeModel
let cursorPosition
let registeredActions
```

Then update the `fakeEditor` object (around line 56-81) — add `getSelections` and `trigger`, and change `addAction` to capture its config instead of being a no-op:

```js
const fakeEditor = {
  getModel: vi.fn(() => fakeModel),
  getValue: vi.fn(() => fakeModel.getValue()),
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
```

Then reset `registeredActions` alongside the other per-mount state in the `editor.create` mock (around line 86-91):

```js
    create: vi.fn((_el, opts) => {
      fakeModel = createFakeModel(opts.value ?? '')
      cursorPosition = { lineNumber: fakeModel.getLineCount(), column: 1 }
      disposed = false
      registeredActions = {}
      return fakeEditor
    })
```

- [ ] **Step 2: Add a failing test for the fallback path**

Add a new `describe` block at the end of `frontend/src/components/EditorMarkdown.test.js`:

```js
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
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/EditorMarkdown.test.js -t "falls back to default Enter"` from `frontend/`
Expected: FAIL — `registeredActions['markdown.extension.editing.continueList']` is `undefined` (nothing registers that action id yet), so `pressEnter()` throws.

- [ ] **Step 4: Implement `continueList()` and `fallbackToDefaultEnter()`, wire the action**

In `frontend/src/components/EditorMarkdown.vue`, add the following immediately above `function insertBeforeEachLine({ content, before, focus = true }) {` (currently line 1078):

```js
function fallbackToDefaultEnter() {
  editor.trigger('keyboard', 'type', { text: '\n' })
}

function continueList() {
  fallbackToDefaultEnter()
}

```

Then, in the mounted setup, register the action. Insert it right after the `decreaseHeaderLevel` action block and before the `save` action block (currently lines 1853-1867):

```js
  editor.addAction({
    id: 'markdown.extension.editing.continueList',
    keybindings: [monaco.KeyCode.Enter],
    label: 'Continue List',
    precondition: 'editorTextFocus && !suggestWidgetVisible && !renameInputVisible',
    run(ed) {
      continueList()
    }
  })

  editor.addAction({
    id: 'save',
    ...
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/EditorMarkdown.test.js -t "falls back to default Enter"` from `frontend/`
Expected: PASS

- [ ] **Step 6: Format, lint, run the full scoped file**

```bash
cd frontend
npx oxfmt src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
npx oxlint src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
npx vitest run src/components/EditorMarkdown.test.js
```

Expected: all pass, no lint errors, full file's existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/EditorMarkdown.vue frontend/src/components/EditorMarkdown.test.js
git commit -m "feat: wire Monaco Enter action for list continuation (OpenProject #802)"
```

---

## Task 2: Continue the list on Enter, then guard the cases that must not

This task is deliberately two sub-cycles, in this order: first the happy-path continuation logic with
no guards at all, then the guard clauses. Writing the guard tests against a guard-less implementation is
what makes them genuinely fail before they're implemented — against Task 1's unconditional-fallback stub,
every guard test would trivially pass for the wrong reason (it *always* falls back), which proves nothing.

**Files:**
- Modify: `frontend/src/components/EditorMarkdown.vue` (add `detectListMarker`, `nextMarkerText`, and the continuation body of `continueList()`; then add the guard checks)
- Modify: `frontend/src/components/EditorMarkdown.test.js` (add continuation tests, then guard tests, to the Task 1 `describe` block)

**Interfaces:**
- Consumes: `continueList()`, `fallbackToDefaultEnter()` from Task 1; `fakeEditor.getSelections` mock from Task 1.
- Produces: `detectListMarker(lineContent)` → `{ type: 'task' | 'ordered' | 'unordered', indent: string, markerLength: number, number?: number, delimiter?: string } | null`. `nextMarkerText(detected)` → `string`. Task 3 calls both.

### Sub-cycle A: continuation, no guards yet

- [ ] **Step 1: Add failing tests for continuation**

Add inside the same `describe` block as Task 1's test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/EditorMarkdown.test.js -t "continues"` from `frontend/`
Expected: FAIL — Task 1's `continueList()` unconditionally falls back, so `fakeModel.getValue()` still equals the original single-line content in every case above, and `fakeEditor.trigger` was called (contradicting `expect(fakeEditor.trigger).not.toHaveBeenCalled()` in the first test).

- [ ] **Step 3: Implement detection and the continuation edit (no guards yet)**

In `frontend/src/components/EditorMarkdown.vue`, replace the Task 1 `continueList()`/`fallbackToDefaultEnter()` pair with the following (still immediately above `insertBeforeEachLine`):

```js
const TASK_LIST_MARKER_RE = /^(\s*)-\s\[([ xX])\]\s/
const ORDERED_LIST_MARKER_RE = /^(\s*)(\d+)([.)])\s/
const UNORDERED_LIST_MARKER_RE = /^(\s*)([-*+])\s/

function detectListMarker(lineContent) {
  let match = lineContent.match(TASK_LIST_MARKER_RE)
  if (match) {
    return { type: 'task', indent: match[1], markerLength: match[0].length }
  }
  match = lineContent.match(ORDERED_LIST_MARKER_RE)
  if (match) {
    return {
      type: 'ordered',
      indent: match[1],
      markerLength: match[0].length,
      number: Number.parseInt(match[2], 10),
      delimiter: match[3]
    }
  }
  match = lineContent.match(UNORDERED_LIST_MARKER_RE)
  if (match) {
    return { type: 'unordered', indent: match[1], markerLength: match[0].length }
  }
  return null
}

function nextMarkerText(detected) {
  switch (detected.type) {
    case 'task':
      return '- [ ] '
    case 'ordered':
      return `${detected.number + 1}${detected.delimiter} `
    default:
      return '- '
  }
}

function fallbackToDefaultEnter() {
  editor.trigger('keyboard', 'type', { text: '\n' })
}

function continueList() {
  const selection = editor.getSelections()[0]
  const line = selection.startLineNumber
  const column = selection.startColumn
  const lineContent = editor.getModel().getLineContent(line)
  const detected = detectListMarker(lineContent)

  if (!detected) {
    fallbackToDefaultEnter()
    return
  }

  const marker = detected.indent + nextMarkerText(detected)
  editor.executeEdits('wikijs.continueList', [
    { range: new Range(line, column, line, column), text: `\n${marker}`, forceMoveMarkers: true }
  ])
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/EditorMarkdown.test.js` from `frontend/`
Expected: PASS — every test in the file, including Task 1's fallback test (a plain line still has no `detectListMarker` match) and all of this step's new continuation tests.

- [ ] **Step 5: Commit the happy path**

```bash
cd frontend
npx oxfmt src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
npx oxlint src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
git add frontend/src/components/EditorMarkdown.vue frontend/src/components/EditorMarkdown.test.js
git commit -m "feat: continue unordered/ordered/task lists on Enter (OpenProject #802)"
```

### Sub-cycle B: guard the cases that must fall back instead

- [ ] **Step 6: Add failing tests for the guard cases**

Add inside the same `describe` block, after the tests from Step 1:

```js
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
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/components/EditorMarkdown.test.js -t "falls back when"` from `frontend/`
Expected: FAIL, all three. `continueList()` from Step 3 only reads `getSelections()[0]`, so the multi-cursor and non-empty-selection tests both still perform a continuation edit instead of falling back. The pre-marker-cursor test performs a split at column 1, producing `'\n- - one'` instead of leaving `'- one'` untouched, and never calls `trigger`.

- [ ] **Step 8: Add the guard checks**

In `frontend/src/components/EditorMarkdown.vue`, replace the start of `continueList()` (everything up to and including the `detectListMarker` call) with:

```js
function continueList() {
  const selections = editor.getSelections()
  if (selections.length !== 1 || !selections[0].isEmpty()) {
    fallbackToDefaultEnter()
    return
  }

  const selection = selections[0]
  const line = selection.startLineNumber
  const column = selection.startColumn
  const lineContent = editor.getModel().getLineContent(line)
  const detected = detectListMarker(lineContent)

  // -> A regex match doesn't mean the CURSOR is past the marker -- Enter pressed ahead of or
  //    inside the marker itself (e.g. column 1, before the leading whitespace) isn't
  //    continuation. Without this guard the split below would duplicate the marker onto the line
  //    it pushes down, since "text before the cursor" would be empty and "text at/after the
  //    cursor" would be the whole original marker-and-content line.
  if (!detected || column < detected.markerLength + 1) {
    fallbackToDefaultEnter()
    return
  }

  const marker = detected.indent + nextMarkerText(detected)
  editor.executeEdits('wikijs.continueList', [
    { range: new Range(line, column, line, column), text: `\n${marker}`, forceMoveMarkers: true }
  ])
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/components/EditorMarkdown.test.js` from `frontend/`
Expected: PASS — every test in the file, guard tests included, with the Sub-cycle A continuation tests still green.

- [ ] **Step 10: Format, lint, commit**

```bash
cd frontend
npx oxfmt src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
npx oxlint src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
git add frontend/src/components/EditorMarkdown.vue frontend/src/components/EditorMarkdown.test.js
git commit -m "feat: guard list continuation against multi-cursor and pre-marker Enter (OpenProject #802)"
```

---

## Task 3: Exit the list on an empty item

**Files:**
- Modify: `frontend/src/components/EditorMarkdown.vue` (add the empty-remainder branch to `continueList()`)
- Modify: `frontend/src/components/EditorMarkdown.test.js` (add exit test cases)

**Interfaces:**
- Consumes: `detectListMarker()` from Task 2, and `continueList()`'s existing guard checks.
- Produces: nothing new consumed by later tasks — this is the last task.

- [ ] **Step 1: Add failing tests for the exit behavior**

Add inside the same `describe` block:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/EditorMarkdown.test.js -t "exits"` from `frontend/`
Expected: FAIL. Task 2's `continueList()` treats an empty-remainder line the same as any other match: it still passes the guard (cursor is at the end of the marker) and runs the generic continuation edit, inserting a second, duplicate bare-marker line below the first instead of clearing it — e.g. `'- one\n- '` becomes `'- one\n- \n- '`, not the expected `'- one\n'`.

- [ ] **Step 3: Add the exit branch**

In `frontend/src/components/EditorMarkdown.vue`, insert this block into `continueList()` between the guard `if` (added in Task 2 Step 8) and the final `marker`/`executeEdits` statements:

```js
  const remainder = lineContent.slice(detected.markerLength)

  if (remainder.length === 0) {
    const lineMaxColumn = editor.getModel().getLineMaxColumn(line)
    editor.executeEdits('wikijs.continueList', [
      { range: new Range(line, 1, line, lineMaxColumn), text: '', forceMoveMarkers: true }
    ])
    return
  }

```

The full `continueList()` function, after Tasks 1-3, reads:

```js
function continueList() {
  const selections = editor.getSelections()
  if (selections.length !== 1 || !selections[0].isEmpty()) {
    fallbackToDefaultEnter()
    return
  }

  const selection = selections[0]
  const line = selection.startLineNumber
  const column = selection.startColumn
  const lineContent = editor.getModel().getLineContent(line)
  const detected = detectListMarker(lineContent)

  if (!detected || column < detected.markerLength + 1) {
    fallbackToDefaultEnter()
    return
  }

  const remainder = lineContent.slice(detected.markerLength)

  if (remainder.length === 0) {
    const lineMaxColumn = editor.getModel().getLineMaxColumn(line)
    editor.executeEdits('wikijs.continueList', [
      { range: new Range(line, 1, line, lineMaxColumn), text: '', forceMoveMarkers: true }
    ])
    return
  }

  const marker = detected.indent + nextMarkerText(detected)
  editor.executeEdits('wikijs.continueList', [
    { range: new Range(line, column, line, column), text: `\n${marker}`, forceMoveMarkers: true }
  ])
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/EditorMarkdown.test.js` from `frontend/`
Expected: PASS, every test in the file (this task's four new ones plus everything from Tasks 1-2 and the file's pre-existing suites).

- [ ] **Step 5: Format, lint**

```bash
cd frontend
npx oxfmt src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
npx oxlint src/components/EditorMarkdown.vue src/components/EditorMarkdown.test.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/EditorMarkdown.vue frontend/src/components/EditorMarkdown.test.js
git commit -m "feat: exit list on empty-item Enter (OpenProject #802)"
```
