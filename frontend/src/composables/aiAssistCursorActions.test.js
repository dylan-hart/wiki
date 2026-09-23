import { describe, expect, it, vi } from 'vitest'

import {
  AI_CURSOR_ACTIONS,
  AI_CURSOR_MENU_GROUP,
  AI_CURSOR_PRECONDITION,
  endOfInsertion,
  promptViaDialog,
  registerAiCursorActions,
  textBeforeCursor
} from './aiAssistCursorActions.js'

function createModel(initial) {
  let lines = initial.split('\n')
  let decorations = new Map()
  let seq = 0
  let disposed = false
  return {
    getValue: () => lines.join('\n'),
    getValueInRange({ startLineNumber, startColumn, endLineNumber, endColumn }) {
      const slice = lines.slice(startLineNumber - 1, endLineNumber)
      if (slice.length === 0) return ''
      slice[slice.length - 1] = slice[slice.length - 1].slice(0, endColumn - 1)
      slice[0] = slice[0].slice(startColumn - 1)
      return slice.join('\n')
    },
    deltaDecorations(oldIds, newDecorations) {
      for (const id of oldIds) decorations.delete(id)
      return newDecorations.map((decoration) => {
        const id = `d${++seq}`
        decorations.set(id, { ...decoration.range })
        return id
      })
    },
    getDecorationRange: (id) => decorations.get(id) ?? null,
    moveDecoration(id, range) {
      decorations.set(id, range)
    },
    decorationCount: () => decorations.size,
    setValue(value) {
      lines = value.split('\n')
      decorations = new Map()
    },
    dispose() {
      disposed = true
    },
    isDisposed: () => disposed,
    applyEdit({ range, text }) {
      const startLine = lines[range.startLineNumber - 1] ?? ''
      const endLine = lines[range.endLineNumber - 1] ?? ''
      const inserted = text.split('\n')
      inserted[0] = startLine.slice(0, range.startColumn - 1) + inserted[0]
      inserted[inserted.length - 1] += endLine.slice(range.endColumn - 1)
      lines.splice(
        range.startLineNumber - 1,
        range.endLineNumber - range.startLineNumber + 1,
        ...inserted
      )
    }
  }
}

function createEditor(content, position) {
  const model = createModel(content)
  const calls = []
  const actions = {}
  const editor = {
    model,
    calls,
    actions,
    getModel: vi.fn(() => model),
    getPosition: vi.fn(() => position),
    addAction: vi.fn((config) => {
      actions[config.id] = config
      return { dispose: vi.fn() }
    }),
    pushUndoStop: vi.fn(() => calls.push('undoStop')),
    executeEdits: vi.fn((source, edits, cursorState) => {
      calls.push({ source, edits, cursorState })
      for (const edit of edits) model.applyEdit(edit)
      return true
    })
  }
  return editor
}

function createDeps(overrides = {}) {
  return {
    t: (key) => `t:${key}`,
    askPrompt: vi.fn(() => Promise.resolve('')),
    generate: vi.fn(() => Promise.resolve('OUT')),
    notify: vi.fn(),
    errorMessage: vi.fn((err) => err?.message ?? 'unknown'),
    ...overrides
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('registerAiCursorActions registration', () => {
  it('registers Expand and Generate as context-menu actions', () => {
    const editor = createEditor('', { lineNumber: 1, column: 1 })
    registerAiCursorActions(editor, createDeps())

    expect(Object.keys(editor.actions)).toEqual(['cardinal.ai.expand', 'cardinal.ai.generate'])
    expect(editor.actions['cardinal.ai.expand']).toMatchObject({
      label: 't:editor.aiCursor.expand',
      contextMenuGroupId: AI_CURSOR_MENU_GROUP
    })
    expect(editor.actions['cardinal.ai.generate']).toMatchObject({
      label: 't:editor.aiCursor.generate',
      contextMenuGroupId: AI_CURSOR_MENU_GROUP
    })
  })

  it('gates both actions on the cardinalAiAssist key and on there being no selection', () => {
    const editor = createEditor('', { lineNumber: 1, column: 1 })
    registerAiCursorActions(editor, createDeps())

    const terms = AI_CURSOR_PRECONDITION.split('&&').map((term) => term.trim())
    expect(terms).toContain('cardinalAiAssist')
    expect(terms).toContain('!editorHasSelection')
    for (const spec of AI_CURSOR_ACTIONS) {
      expect(editor.actions[spec.id].precondition).toBe(AI_CURSOR_PRECONDITION)
    }
  })

  it('returns the disposables addAction hands back', () => {
    const editor = createEditor('', { lineNumber: 1, column: 1 })
    const disposables = registerAiCursorActions(editor, createDeps())
    expect(disposables).toHaveLength(2)
    expect(disposables.every((d) => typeof d.dispose === 'function')).toBe(true)
  })
})

describe('registerAiCursorActions running', () => {
  it('Expand sends the text before the cursor without a prompt and inserts at the cursor', async () => {
    const editor = createEditor('Hello world\nsecond', { lineNumber: 1, column: 6 })
    const deps = createDeps({ generate: vi.fn(() => Promise.resolve(' there')) })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.expand'].run(editor)

    expect(deps.askPrompt).toHaveBeenCalledWith({ action: 'expand', required: false })
    expect(deps.generate).toHaveBeenCalledWith({ action: 'expand', text: 'Hello' })
    expect(editor.model.getValue()).toBe('Hello there world\nsecond')
  })

  it('Generate passes the prompt along and requires one', async () => {
    const editor = createEditor('Intro', { lineNumber: 1, column: 6 })
    const deps = createDeps({
      askPrompt: vi.fn(() => Promise.resolve('Write a list')),
      generate: vi.fn(() => Promise.resolve('\n- a\n- b'))
    })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.generate'].run(editor)

    expect(deps.askPrompt).toHaveBeenCalledWith({ action: 'generate', required: true })
    expect(deps.generate).toHaveBeenCalledWith({
      action: 'generate',
      text: 'Intro',
      prompt: 'Write a list'
    })
    expect(editor.model.getValue()).toBe('Intro\n- a\n- b')
  })

  it('wraps the insertion in undo stops so one undo reverts it, and puts the caret after it', async () => {
    const editor = createEditor('ab', { lineNumber: 1, column: 2 })
    const deps = createDeps({ generate: vi.fn(() => Promise.resolve('X\nYZ')) })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.expand'].run(editor)

    expect(editor.calls[0]).toBe('undoStop')
    expect(editor.calls[2]).toBe('undoStop')
    const edit = editor.calls[1]
    expect(edit.source).toBe('cardinal-ai')
    expect(edit.edits).toHaveLength(1)
    expect(edit.cursorState).toEqual([
      {
        selectionStartLineNumber: 2,
        selectionStartColumn: 3,
        positionLineNumber: 2,
        positionColumn: 3
      }
    ])
    expect(editor.model.getValue()).toBe('aX\nYZb')
  })

  it('inserts where the tracked point moved to, not where the cursor was', async () => {
    const editor = createEditor('line one\nline two', { lineNumber: 1, column: 5 })
    const gate = deferred()
    const deps = createDeps({ generate: vi.fn(() => gate.promise) })
    registerAiCursorActions(editor, deps)

    const running = editor.actions['cardinal.ai.expand'].run(editor)
    await Promise.resolve()
    editor.model.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'NEW\n'
    })
    editor.model.moveDecoration('d1', {
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 5
    })
    gate.resolve('!')
    await running

    expect(editor.model.getValue()).toBe('NEW\nline! one\nline two')
  })

  it('does nothing when the prompt is cancelled', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const deps = createDeps({ askPrompt: vi.fn(() => Promise.resolve(null)) })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.generate'].run(editor)

    expect(deps.generate).not.toHaveBeenCalled()
    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(editor.model.decorationCount()).toBe(0)
  })

  it('discards the output when the document was replaced while the request ran', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const gate = deferred()
    const deps = createDeps({ generate: vi.fn(() => gate.promise) })
    registerAiCursorActions(editor, deps)

    const running = editor.actions['cardinal.ai.expand'].run(editor)
    await Promise.resolve()
    editor.model.setValue('replaced')
    gate.resolve('OUT')
    await running

    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(editor.model.getValue()).toBe('replaced')
    expect(deps.notify).toHaveBeenCalledWith({
      type: 'warning',
      message: 't:editor.aiCursor.discarded'
    })
  })

  it('discards the output when the editor switched to another model', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const gate = deferred()
    const deps = createDeps({ generate: vi.fn(() => gate.promise) })
    registerAiCursorActions(editor, deps)

    const running = editor.actions['cardinal.ai.expand'].run(editor)
    await Promise.resolve()
    editor.getModel.mockReturnValue(createModel('other'))
    gate.resolve('OUT')
    await running

    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith({
      type: 'warning',
      message: 't:editor.aiCursor.discarded'
    })
  })

  it('reports a refused or failed request with the server message and edits nothing', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const deps = createDeps({
      generate: vi.fn(() => Promise.reject(new Error('Daily AI limit reached.')))
    })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.expand'].run(editor)

    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith({
      type: 'negative',
      message: 't:editor.aiCursor.failed',
      caption: 'Daily AI limit reached.'
    })
    expect(editor.model.decorationCount()).toBe(0)
  })

  it('reports an empty answer instead of inserting nothing', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const deps = createDeps({ generate: vi.fn(() => Promise.resolve('')) })
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.expand'].run(editor)

    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith({
      type: 'warning',
      message: 't:editor.aiCursor.empty'
    })
  })

  it('allows one request at a time across both actions', async () => {
    const editor = createEditor('abc', { lineNumber: 1, column: 4 })
    const gate = deferred()
    const deps = createDeps({ generate: vi.fn(() => gate.promise) })
    registerAiCursorActions(editor, deps)

    const first = editor.actions['cardinal.ai.expand'].run(editor)
    await editor.actions['cardinal.ai.generate'].run(editor)

    expect(deps.notify).toHaveBeenCalledWith({ type: 'warning', message: 't:editor.aiCursor.busy' })
    gate.resolve('!')
    await first
    expect(deps.generate).toHaveBeenCalledTimes(1)

    await editor.actions['cardinal.ai.generate'].run(editor)
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a model or a cursor', async () => {
    const editor = createEditor('abc', null)
    const deps = createDeps()
    registerAiCursorActions(editor, deps)

    await editor.actions['cardinal.ai.expand'].run(editor)

    expect(deps.askPrompt).not.toHaveBeenCalled()
  })
})

describe('textBeforeCursor', () => {
  it('returns everything before the cursor', () => {
    const model = createModel('one\ntwo\nthree')
    expect(textBeforeCursor(model, { lineNumber: 2, column: 3 })).toBe('one\ntw')
  })

  it('keeps only the last max characters', () => {
    const model = createModel('abcdefghij')
    expect(textBeforeCursor(model, { lineNumber: 1, column: 11 }, 4)).toBe('ghij')
  })

  it('never starts on half of a surrogate pair', () => {
    const model = createModel('a\u{1F600}bc')
    expect(textBeforeCursor(model, { lineNumber: 1, column: 6 }, 3)).toBe('bc')
  })
})

describe('endOfInsertion', () => {
  it('advances the column for single-line text', () => {
    expect(endOfInsertion({ lineNumber: 3, column: 4 }, 'abc')).toEqual({
      lineNumber: 3,
      column: 7
    })
  })

  it('lands after the last line for multi-line text', () => {
    expect(endOfInsertion({ lineNumber: 3, column: 4 }, 'a\nbb\nccc')).toEqual({
      lineNumber: 5,
      column: 4
    })
  })
})

describe('promptViaDialog', () => {
  function fakeDialog() {
    const handlers = {}
    const chain = {
      onOk(cb) {
        handlers.ok = cb
        return chain
      },
      onCancel(cb) {
        handlers.cancel = cb
        return chain
      }
    }
    return { dialog: vi.fn(() => chain), handlers }
  }

  it('resolves with the entered prompt', async () => {
    const { dialog, handlers } = fakeDialog()
    const result = promptViaDialog(dialog, 'Comp', { action: 'generate' })
    expect(dialog).toHaveBeenCalledWith({
      component: 'Comp',
      componentProps: { action: 'generate' }
    })
    handlers.ok({ prompt: 'hi' })
    await expect(result).resolves.toBe('hi')
  })

  it('resolves null when cancelled', async () => {
    const { dialog, handlers } = fakeDialog()
    const result = promptViaDialog(dialog, 'Comp', {})
    handlers.cancel()
    await expect(result).resolves.toBeNull()
  })
})
