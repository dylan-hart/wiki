import { describe, expect, it, vi } from 'vitest'

// -> `monaco-editor`'s real entry point needs browser layout/measurement APIs `happy-dom` does not
//    provide. Only `Range` and `Position` are reachable from this module, and only as plain value
//    objects, so a two-class stand-in is the whole of what a mock has to be here.
vi.mock('monaco-editor', () => ({
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
  }
}))

const { continueList } = await import('./markdownInsert.js')

/**
 * `continueList` labels both of its edits with a Monaco "edit source" id, which is what Monaco
 * groups an undo step under and what an `onDidChangeModelContent` listener reads off `e.source` to
 * tell one command's edit from another's. Nothing else pins it, and its two `executeEdits` call
 * sites can drift apart with no runtime error, so both are asserted.
 */
function fakeEditor(lineContent, column) {
  const executeEdits = vi.fn()
  const trigger = vi.fn()
  return {
    executeEdits,
    trigger,
    getSelections: () => [
      {
        isEmpty: () => true,
        startLineNumber: 1,
        startColumn: column
      }
    ],
    getModel: () => ({
      getLineContent: () => lineContent,
      getLineMaxColumn: () => lineContent.length + 1
    })
  }
}

describe('continueList edit source id', () => {
  it('labels the continuation edit with the current product id', () => {
    const editor = fakeEditor('- first item', 13)

    continueList(editor)

    expect(editor.executeEdits).toHaveBeenCalledTimes(1)
    expect(editor.executeEdits.mock.calls[0][0]).toBe('cardinaljs.continueList')
    expect(editor.executeEdits.mock.calls[0][1][0].text).toBe('\n- ')
  })

  it('labels the clear-the-empty-marker edit with the same id', () => {
    // -> Enter on "- " with nothing after it ends the list -- the other `executeEdits` call site
    const editor = fakeEditor('- ', 3)

    continueList(editor)

    expect(editor.executeEdits).toHaveBeenCalledTimes(1)
    expect(editor.executeEdits.mock.calls[0][0]).toBe('cardinaljs.continueList')
    expect(editor.executeEdits.mock.calls[0][1][0].text).toBe('')
  })

  it('does not label anything when there is no list to continue', () => {
    const editor = fakeEditor('plain paragraph text', 21)

    continueList(editor)

    expect(editor.executeEdits).not.toHaveBeenCalled()
    expect(editor.trigger).toHaveBeenCalledWith('keyboard', 'type', { text: '\n' })
  })
})
