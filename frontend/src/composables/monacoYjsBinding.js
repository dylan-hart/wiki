import * as monaco from 'monaco-editor'
import * as Y from 'yjs'

/**
 * A port of `y-monaco`'s `MonacoBinding` (0.1.6) -- text sync and the awareness-driven remote
 * cursor/selection decorations both. The `yRemoteSelection-<clientId>` /
 * `yRemoteSelectionHead-<clientId>` class names are the ones `composables/collab.js`'s
 * `renderCursorStyles` generates a stylesheet for, so the two must stay in step.
 * `createReentrancyGuard` stands in for `lib0`'s `createMutex`: `lib0` reaches `frontend/` only
 * through `yjs`, never as a declared dependency.
 */

/**
 * Runs `fn` unless already inside a call to the same guard, dropping the nested call rather than
 * queueing it. Without it a Yjs update applied INTO Monaco bounces back out through Monaco's
 * `onDidChangeContent` into the very `Y.Text` it came from, and `beforeAllTransactions` captures a
 * selection for transactions this binding started itself.
 */
function createReentrancyGuard() {
  let active = false
  return (fn) => {
    if (active) {
      return
    }
    active = true
    try {
      fn()
    } finally {
      active = false
    }
  }
}

class SavedSelection {
  constructor(start, end, direction) {
    this.start = start
    this.end = end
    this.direction = direction
  }
}

function captureSelection(editor, model, ytext) {
  const selection = editor.getSelection()
  if (!selection) {
    return null
  }
  const startPos = selection.getStartPosition()
  const endPos = selection.getEndPosition()
  return new SavedSelection(
    Y.createRelativePositionFromTypeIndex(ytext, model.getOffsetAt(startPos)),
    Y.createRelativePositionFromTypeIndex(ytext, model.getOffsetAt(endPos)),
    selection.getDirection()
  )
}

function restoreSelection(editor, ytext, doc, saved) {
  const start = Y.createAbsolutePositionFromRelativePosition(saved.start, doc)
  const end = Y.createAbsolutePositionFromRelativePosition(saved.end, doc)
  if (!start || !end || start.type !== ytext || end.type !== ytext) {
    return
  }
  const model = editor.getModel()
  if (!model) {
    return
  }
  const startPos = model.getPositionAt(start.index)
  const endPos = model.getPositionAt(end.index)
  editor.setSelection(
    monaco.Selection.createWithDirection(
      startPos.lineNumber,
      startPos.column,
      endPos.lineNumber,
      endPos.column,
      saved.direction
    )
  )
}

export class MonacoYjsBinding {
  /**
   * @param {import('yjs').Text} ytext
   * @param {object} monacoModel
   * @param {Set<object>} [editors]
   * @param {object|null} [awareness]
   */
  constructor(ytext, monacoModel, editors = new Set(), awareness = null) {
    this.doc = ytext.doc
    this.ytext = ytext
    this.model = monacoModel
    this.editors = editors
    this.awareness = awareness

    const guard = createReentrancyGuard()
    this._savedSelections = new Map()
    this._decorations = new Map()
    this._cursorSelectionDisposables = []

    this._onBeforeTransaction = () => {
      guard(() => {
        this._savedSelections = new Map()
        for (const editor of this.editors) {
          if (editor.getModel() !== monacoModel) {
            continue
          }
          const saved = captureSelection(editor, monacoModel, ytext)
          if (saved) {
            this._savedSelections.set(editor, saved)
          }
        }
      })
    }
    this.doc.on('beforeAllTransactions', this._onBeforeTransaction)

    this._onTextChange = (event) => {
      guard(() => {
        let index = 0
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain
          } else if (op.insert !== undefined) {
            const pos = monacoModel.getPositionAt(index)
            monacoModel.applyEdits([
              {
                range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
                text: op.insert
              }
            ])
            index += op.insert.length
          } else if (op.delete !== undefined) {
            const start = monacoModel.getPositionAt(index)
            const end = monacoModel.getPositionAt(index + op.delete)
            monacoModel.applyEdits([
              {
                range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                text: ''
              }
            ])
          }
        }
        for (const [editor, saved] of this._savedSelections) {
          restoreSelection(editor, ytext, this.doc, saved)
        }
      })
      this._renderRemoteDecorations()
    }
    ytext.observe(this._onTextChange)

    const initialValue = ytext.toString()
    if (monacoModel.getValue() !== initialValue) {
      monacoModel.setValue(initialValue)
    }

    this._onModelChange = monacoModel.onDidChangeContent((event) => {
      guard(() => {
        this.doc.transact(() => {
          const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
          for (const change of changes) {
            ytext.delete(change.rangeOffset, change.rangeLength)
            ytext.insert(change.rangeOffset, change.text)
          }
        }, this)
      })
    })

    this._onModelDispose = monacoModel.onWillDispose(() => {
      this.destroy()
    })

    if (awareness) {
      for (const editor of this.editors) {
        this._cursorSelectionDisposables.push(
          editor.onDidChangeCursorSelection(() => {
            if (editor.getModel() !== monacoModel) {
              return
            }
            const selection = editor.getSelection()
            if (!selection) {
              return
            }
            let anchor = monacoModel.getOffsetAt(selection.getStartPosition())
            let head = monacoModel.getOffsetAt(selection.getEndPosition())
            if (selection.getDirection() === monaco.SelectionDirection.RTL) {
              ;[anchor, head] = [head, anchor]
            }
            awareness.setLocalStateField('selection', {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
              head: Y.createRelativePositionFromTypeIndex(ytext, head)
            })
          })
        )
      }
      this._onAwarenessChange = () => this._renderRemoteDecorations()
      awareness.on('change', this._onAwarenessChange)
    }
  }

  _renderRemoteDecorations() {
    for (const editor of this.editors) {
      if (!this.awareness || editor.getModel() !== this.model) {
        this._decorations.delete(editor)
        continue
      }
      const current = this._decorations.get(editor) || []
      const next = []
      this.awareness.getStates().forEach((state, clientId) => {
        if (clientId === this.doc.clientID) {
          return
        }
        const selection = state?.selection
        if (selection?.anchor == null || selection?.head == null) {
          return
        }
        const anchorAbs = Y.createAbsolutePositionFromRelativePosition(selection.anchor, this.doc)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(selection.head, this.doc)
        if (
          !anchorAbs ||
          !headAbs ||
          anchorAbs.type !== this.ytext ||
          headAbs.type !== this.ytext
        ) {
          return
        }
        let start, end, afterContentClassName, beforeContentClassName
        if (anchorAbs.index < headAbs.index) {
          start = this.model.getPositionAt(anchorAbs.index)
          end = this.model.getPositionAt(headAbs.index)
          afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
          beforeContentClassName = null
        } else {
          start = this.model.getPositionAt(headAbs.index)
          end = this.model.getPositionAt(anchorAbs.index)
          afterContentClassName = null
          beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
        }
        next.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            className: `yRemoteSelection yRemoteSelection-${clientId}`,
            afterContentClassName,
            beforeContentClassName
          }
        })
      })
      this._decorations.set(editor, editor.deltaDecorations(current, next))
    }
  }

  destroy() {
    this._onModelChange.dispose()
    this._onModelDispose.dispose()
    this.ytext.unobserve(this._onTextChange)
    this.doc.off('beforeAllTransactions', this._onBeforeTransaction)
    for (const disposable of this._cursorSelectionDisposables) {
      disposable.dispose()
    }
    this._cursorSelectionDisposables = []
    if (this.awareness && this._onAwarenessChange) {
      this.awareness.off('change', this._onAwarenessChange)
    }
  }
}
