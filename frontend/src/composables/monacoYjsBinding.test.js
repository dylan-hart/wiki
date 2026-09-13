import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

/*
  A minimal but behaviourally-real `Range`/`Selection`/`SelectionDirection` stand-in, not a set of
  no-op spies: the binding under test relies on their actual field shapes (`startLineNumber` etc.) and
  on `Selection.createWithDirection`'s return value round-tripping back through a later
  `editor.getSelection()` call, so a bare `vi.fn()` mock (as most other suites use for `monaco-editor`,
  which never exercises this deep into the API) would not exercise the real math this file exists to
  get right.
*/
vi.mock('monaco-editor', () => {
  class FakeRange {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      this.startLineNumber = startLineNumber
      this.startColumn = startColumn
      this.endLineNumber = endLineNumber
      this.endColumn = endColumn
    }
  }

  class FakeSelection extends FakeRange {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn, direction) {
      super(startLineNumber, startColumn, endLineNumber, endColumn)
      this.direction = direction
    }

    getStartPosition() {
      return { lineNumber: this.startLineNumber, column: this.startColumn }
    }

    getEndPosition() {
      return { lineNumber: this.endLineNumber, column: this.endColumn }
    }

    getDirection() {
      return this.direction
    }

    static createWithDirection(startLineNumber, startColumn, endLineNumber, endColumn, direction) {
      return new FakeSelection(startLineNumber, startColumn, endLineNumber, endColumn, direction)
    }
  }

  return {
    Range: FakeRange,
    Selection: FakeSelection,
    SelectionDirection: { LTR: 0, RTL: 1 }
  }
})

const { MonacoYjsBinding } = await import('./monacoYjsBinding.js')
const monaco = await import('monaco-editor')

// ----------------------------------------
// A small real (position<->offset-accurate) fake Monaco model/editor
// ----------------------------------------

function offsetAt(value, position) {
  const lines = value.split('\n')
  let offset = 0
  for (let i = 0; i < position.lineNumber - 1; i++) {
    offset += lines[i].length + 1
  }
  return offset + position.column - 1
}

function positionAt(value, offset) {
  const lines = value.split('\n')
  let remaining = offset
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].length) {
      return { lineNumber: i + 1, column: remaining + 1 }
    }
    remaining -= lines[i].length + 1
  }
  const lastLine = lines[lines.length - 1]
  return { lineNumber: lines.length, column: lastLine.length + 1 }
}

/**
 * A single-edit-per-call model -- every real call site in `monacoYjsBinding.js` applies one edit at a
 * time, so this does not need to reproduce Monaco's multi-edit batching/ordering rules to be faithful.
 */
function createFakeModel(initialValue = '') {
  let value = initialValue
  let disposed = false
  const contentListeners = new Set()
  return {
    getValue: () => value,
    setValue: (next) => {
      value = next
    },
    getPositionAt: (offset) => positionAt(value, offset),
    getOffsetAt: (position) => offsetAt(value, position),
    applyEdits: (edits) => {
      const [{ range, text }] = edits
      const startOffset = offsetAt(value, {
        lineNumber: range.startLineNumber,
        column: range.startColumn
      })
      const endOffset = offsetAt(value, {
        lineNumber: range.endLineNumber,
        column: range.endColumn
      })
      const rangeLength = endOffset - startOffset
      value = value.slice(0, startOffset) + text + value.slice(endOffset)
      for (const listener of contentListeners) {
        listener({ changes: [{ rangeOffset: startOffset, rangeLength, text }] })
      }
    },
    onDidChangeContent: (cb) => {
      contentListeners.add(cb)
      return { dispose: () => contentListeners.delete(cb) }
    },
    onWillDispose: () => ({ dispose: () => {} }),
    isDisposed: () => disposed,
    _dispose: () => {
      disposed = true
    }
  }
}

function createFakeEditor(model) {
  let selection = null
  const cursorListeners = new Set()
  const editor = {
    getModel: () => model,
    getSelection: () => selection,
    setSelection: (sel) => {
      selection = sel
    },
    // -> Test-only helper: moves the cursor AND fires the same callback the real editor fires,
    //    since nothing in happy-dom will do that for us.
    _moveSelection(sel) {
      selection = sel
      for (const listener of cursorListeners) {
        listener()
      }
    },
    onDidChangeCursorSelection: (cb) => {
      cursorListeners.add(cb)
      return { dispose: () => cursorListeners.delete(cb) }
    },
    deltaDecorations: vi.fn((_oldIds, newDecorations) => newDecorations.map((_d, i) => `deco-${i}`))
  }
  return editor
}

function selectionAt(model, startOffset, endOffset, direction = monaco.SelectionDirection.LTR) {
  const start = positionAt(model.getValue(), startOffset)
  const end = positionAt(model.getValue(), endOffset)
  return monaco.Selection.createWithDirection(
    start.lineNumber,
    start.column,
    end.lineNumber,
    end.column,
    direction
  )
}

function createFakeAwareness(clientStates = new Map()) {
  const listeners = new Set()
  return {
    localState: null,
    setLocalStateField: vi.fn(function (key, value) {
      this.localState = { ...this.localState, [key]: value }
    }),
    getStates: () => clientStates,
    on: (event, cb) => {
      if (event === 'change') listeners.add(cb)
    },
    off: (event, cb) => {
      if (event === 'change') listeners.delete(cb)
    },
    _emitChange: () => {
      for (const cb of listeners) cb()
    }
  }
}

describe('MonacoYjsBinding', () => {
  let doc
  let ytext

  beforeEach(() => {
    doc = new Y.Doc()
    ytext = doc.getText('content')
  })

  describe('text sync', () => {
    it('seeds the model from whatever the shared document already holds', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const binding = new MonacoYjsBinding(ytext, model)

      expect(model.getValue()).toBe('hello world')
      binding.destroy()
    })

    it('propagates a local Monaco edit into the shared document', () => {
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]))

      model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'hello' }])

      expect(ytext.toString()).toBe('hello')
      binding.destroy()
    })

    it('propagates a remote Yjs update into the Monaco model without feedback-looping it back', () => {
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]))

      // -> Simulates what arriving over the websocket looks like: a transaction this binding did not
      //    itself start.
      doc.transact(() => {
        ytext.insert(0, 'abc')
      })

      expect(model.getValue()).toBe('abc')
      // -> The regression this test exists for: a naive port re-inserts the just-applied text back
      //    into `ytext` via the model's own `onDidChangeContent`, doubling it.
      expect(ytext.toString()).toBe('abc')
      binding.destroy()
    })

    it('remaps a saved selection across a remote edit that shifts its offsets', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]))

      // -> "world" is offsets 6-11 in "hello world"
      editor._moveSelection(selectionAt(model, 6, 11))

      doc.transact(() => {
        ytext.insert(0, 'XX ')
      })

      expect(model.getValue()).toBe('XX hello world')
      const restored = editor.getSelection()
      expect(offsetAt(model.getValue(), restored.getStartPosition())).toBe(9)
      expect(offsetAt(model.getValue(), restored.getEndPosition())).toBe(14)
      binding.destroy()
    })

    it('does not propagate ytext changes once destroyed', () => {
      const model = createFakeModel('')
      const binding = new MonacoYjsBinding(ytext, model)
      binding.destroy()

      doc.transact(() => {
        ytext.insert(0, 'abc')
      })

      expect(model.getValue()).toBe('')
    })
  })

  describe('awareness: publishing this editor’s own selection', () => {
    it('publishes an LTR selection as anchor <= head relative positions', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const awareness = createFakeAwareness()
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)

      editor._moveSelection(selectionAt(model, 2, 7, monaco.SelectionDirection.LTR))

      expect(awareness.setLocalStateField).toHaveBeenCalledWith('selection', expect.anything())
      const { anchor, head } = awareness.localState.selection
      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(anchor, doc)
      const headAbs = Y.createAbsolutePositionFromRelativePosition(head, doc)
      expect(anchorAbs.index).toBe(2)
      expect(headAbs.index).toBe(7)
      binding.destroy()
    })

    it('swaps anchor/head for an RTL selection (dragged backwards)', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const awareness = createFakeAwareness()
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)

      editor._moveSelection(selectionAt(model, 2, 7, monaco.SelectionDirection.RTL))

      const { anchor, head } = awareness.localState.selection
      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(anchor, doc)
      const headAbs = Y.createAbsolutePositionFromRelativePosition(head, doc)
      // -> RTL: the drag started at the later offset and the caret ended up at the earlier one.
      expect(anchorAbs.index).toBe(7)
      expect(headAbs.index).toBe(2)
      binding.destroy()
    })
  })

  describe('awareness: rendering remote participants', () => {
    it('draws a decoration per remote client and skips this client’s own state', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)

      const remoteClientId = 999
      const states = new Map([
        [
          doc.clientID,
          {
            selection: {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, 0),
              head: Y.createRelativePositionFromTypeIndex(ytext, 5)
            }
          }
        ],
        [
          remoteClientId,
          {
            selection: {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, 6),
              head: Y.createRelativePositionFromTypeIndex(ytext, 11)
            }
          }
        ]
      ])
      const awareness = createFakeAwareness(states)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)

      awareness._emitChange()

      expect(editor.deltaDecorations).toHaveBeenCalledTimes(1)
      const [, decorations] = editor.deltaDecorations.mock.calls[0]
      expect(decorations).toHaveLength(1)
      const [decoration] = decorations
      expect(decoration.options.className).toBe(
        `yRemoteSelection yRemoteSelection-${remoteClientId}`
      )
      expect(decoration.options.afterContentClassName).toBe(
        `yRemoteSelectionHead yRemoteSelectionHead-${remoteClientId}`
      )
      expect(decoration.options.beforeContentClassName).toBeNull()
      binding.destroy()
    })

    it('draws the head marker before the range when the remote selection runs head-before-anchor', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)

      const remoteClientId = 7
      const states = new Map([
        [
          remoteClientId,
          {
            // -> anchor AFTER head -- a backwards remote drag
            selection: {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, 11),
              head: Y.createRelativePositionFromTypeIndex(ytext, 6)
            }
          }
        ]
      ])
      const awareness = createFakeAwareness(states)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)

      awareness._emitChange()

      const [decoration] = editor.deltaDecorations.mock.calls.at(-1)[1]
      expect(decoration.options.beforeContentClassName).toBe(
        `yRemoteSelectionHead yRemoteSelectionHead-${remoteClientId}`
      )
      expect(decoration.options.afterContentClassName).toBeNull()
      binding.destroy()
    })

    it('re-renders remote decorations after a text change moves them', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)

      const remoteClientId = 5
      const states = new Map([
        [
          remoteClientId,
          {
            selection: {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, 6),
              head: Y.createRelativePositionFromTypeIndex(ytext, 11)
            }
          }
        ]
      ])
      const awareness = createFakeAwareness(states)
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)
      editor.deltaDecorations.mockClear()

      doc.transact(() => {
        ytext.insert(0, 'XX ')
      })

      expect(editor.deltaDecorations).toHaveBeenCalled()
      const [, decorations] = editor.deltaDecorations.mock.calls.at(-1)
      expect(decorations).toHaveLength(1)
      // -> "world" shifted from offsets 6-11 to 9-14 by the 3-character insert ahead of it
      const { range } = decorations[0]
      const startOffset = offsetAt(model.getValue(), {
        lineNumber: range.startLineNumber,
        column: range.startColumn
      })
      const endOffset = offsetAt(model.getValue(), {
        lineNumber: range.endLineNumber,
        column: range.endColumn
      })
      expect(startOffset).toBe(9)
      expect(endOffset).toBe(14)
      binding.destroy()
    })
  })

  describe('destroy', () => {
    it('stops reacting to awareness changes', () => {
      ytext.insert(0, 'hello world')
      const model = createFakeModel('')
      const editor = createFakeEditor(model)
      const awareness = createFakeAwareness()
      const binding = new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)

      binding.destroy()
      editor.deltaDecorations.mockClear()
      awareness._emitChange()

      expect(editor.deltaDecorations).not.toHaveBeenCalled()
    })
  })
})
