export const AI_CURSOR_PRECONDITION = 'cardinalAiAssist && !editorHasSelection'
export const AI_CURSOR_MENU_GROUP = 'cardinal.ai'
export const AI_TEXT_MAX = 20000
export const AI_PROMPT_MAX = 2000

export const AI_CURSOR_ACTIONS = [
  {
    id: 'cardinal.ai.expand',
    action: 'expand',
    labelKey: 'editor.aiCursor.expand',
    promptRequired: false,
    order: 3
  },
  {
    id: 'cardinal.ai.generate',
    action: 'generate',
    labelKey: 'editor.aiCursor.generate',
    promptRequired: true,
    order: 4
  }
]

const DECORATION_OPTIONS = { description: 'cardinal-ai-insert-point' }

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

export function textBeforeCursor(model, position, max = AI_TEXT_MAX) {
  const text = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  })
  if (text.length <= max) {
    return text
  }
  const tail = text.slice(text.length - max)
  return isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail
}

export function endOfInsertion(start, text) {
  const lines = text.split('\n')
  const lastLine = lines[lines.length - 1]
  return lines.length === 1
    ? { lineNumber: start.lineNumber, column: start.column + lastLine.length }
    : { lineNumber: start.lineNumber + lines.length - 1, column: lastLine.length + 1 }
}

export function insertAtTrackedPoint(editor, model, decorationId, text) {
  if (editor.getModel() !== model || model.isDisposed?.()) {
    return false
  }
  const range = model.getDecorationRange(decorationId)
  if (!range) {
    return false
  }
  const start = { lineNumber: range.startLineNumber, column: range.startColumn }
  const end = endOfInsertion(start, text)
  editor.pushUndoStop()
  editor.executeEdits(
    'cardinal-ai',
    [
      {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: start.lineNumber,
          endColumn: start.column
        },
        text,
        forceMoveMarkers: true
      }
    ],
    [
      {
        selectionStartLineNumber: end.lineNumber,
        selectionStartColumn: end.column,
        positionLineNumber: end.lineNumber,
        positionColumn: end.column
      }
    ]
  )
  editor.pushUndoStop()
  return true
}

export function promptViaDialog(dialog, component, componentProps) {
  return new Promise((resolve) => {
    dialog({ component, componentProps })
      .onOk((payload) => resolve(payload?.prompt ?? ''))
      .onCancel(() => resolve(null))
  })
}

export function registerAiCursorActions(editor, deps) {
  let busy = false

  async function run(spec) {
    if (busy) {
      deps.notify({ type: 'warning', message: deps.t('editor.aiCursor.busy') })
      return
    }
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position) {
      return
    }

    busy = true
    const [decorationId] = model.deltaDecorations(
      [],
      [
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          },
          options: DECORATION_OPTIONS
        }
      ]
    )

    try {
      const prompt = await deps.askPrompt({ action: spec.action, required: spec.promptRequired })
      if (prompt === null) {
        return
      }

      const point = model.isDisposed?.() ? null : model.getDecorationRange(decorationId)
      if (!point) {
        return
      }
      const text = textBeforeCursor(model, {
        lineNumber: point.startLineNumber,
        column: point.startColumn
      })

      let output
      try {
        output = await deps.generate({
          action: spec.action,
          text,
          ...(prompt ? { prompt } : {})
        })
      } catch (err) {
        deps.notify({
          type: 'negative',
          message: deps.t('editor.aiCursor.failed'),
          caption: deps.errorMessage(err)
        })
        return
      }

      if (!output) {
        deps.notify({ type: 'warning', message: deps.t('editor.aiCursor.empty') })
        return
      }

      if (!insertAtTrackedPoint(editor, model, decorationId, output)) {
        deps.notify({ type: 'warning', message: deps.t('editor.aiCursor.discarded') })
      }
    } finally {
      busy = false
      if (!model.isDisposed?.()) {
        model.deltaDecorations([decorationId], [])
      }
    }
  }

  return AI_CURSOR_ACTIONS.map((spec) =>
    editor.addAction({
      id: spec.id,
      label: deps.t(spec.labelKey),
      contextMenuGroupId: AI_CURSOR_MENU_GROUP,
      contextMenuOrder: spec.order,
      precondition: AI_CURSOR_PRECONDITION,
      run: () => run(spec)
    })
  )
}
