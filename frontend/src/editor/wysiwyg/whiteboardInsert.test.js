import { afterEach, describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

import { WikiBlock } from './wikiBlockNode'
import {
  EMPTY_WHITEBOARD_BODY,
  WhiteboardInsert,
  appendedSuffix,
  applyWhiteboardBody,
  enclosingWhiteboard,
  insertWhiteboardInto,
  isDrawShortcut,
  isMacPlatform,
  isPenContact,
  pageWhiteboardBytes,
  penInsertRange,
  whiteboardBodyOf
} from './whiteboardInsert'

const BOARD = '::block-whiteboard\n```whiteboard\n' + EMPTY_WHITEBOARD_BODY + '\n```\n::'

let editor = null

function createEditor(markdown) {
  editor = new Editor({
    content: markdown,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, WikiBlock, WhiteboardInsert]
  })
  return editor
}

function findPos(doc, predicate) {
  let found = null
  doc.descendants((node, pos) => {
    if (found === null && predicate(node)) {
      found = pos
    }
  })
  return found
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('isMacPlatform', () => {
  it.each([
    [{ platform: 'MacIntel' }, true],
    [{ platform: 'iPad' }, true],
    [{ userAgentData: { platform: 'macOS' }, platform: '' }, true],
    [{ platform: 'Win32' }, false],
    [{ platform: 'Linux x86_64' }, false],
    [undefined, false]
  ])('%o -> %s', (nav, expected) => {
    expect(isMacPlatform(nav)).toBe(expected)
  })
})

describe('isDrawShortcut', () => {
  const base = { code: 'KeyP', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false }

  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(isDrawShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isDrawShortcut({ ...base, ctrlKey: true }, true)).toBe(false)
    expect(isDrawShortcut({ ...base, ctrlKey: true }, false)).toBe(true)
    expect(isDrawShortcut({ ...base, metaKey: true }, false)).toBe(false)
  })

  it('matches the physical P key whatever character the layout produces', () => {
    expect(isDrawShortcut({ ...base, key: 'π', metaKey: true }, true)).toBe(true)
    expect(isDrawShortcut({ ...base, code: 'KeyO', key: 'p', metaKey: true }, true)).toBe(false)
  })
})

describe('isPenContact', () => {
  it('accepts only the pen tip', () => {
    expect(isPenContact({ pointerType: 'pen', button: 0 })).toBe(true)
    expect(isPenContact({ pointerType: 'pen', button: 5 })).toBe(false)
    expect(isPenContact({ pointerType: 'mouse', button: 0 })).toBe(false)
    expect(isPenContact({ pointerType: 'touch', button: 0 })).toBe(false)
  })
})

describe('penInsertRange', () => {
  it('lands after a non-empty line inside a list item', () => {
    const { state } = createEditor('- one\n- two')
    const pos = findPos(state.doc, (node) => node.isText && node.text === 'one')
    const range = penInsertRange(state.doc, pos + 1)
    const tr = state.tr
    expect(insertWhiteboardInto(tr, range.from, range.to)).not.toBeNull()
    const item = tr.doc.firstChild.firstChild
    expect(item.type.name).toBe('listItem')
    expect(item.child(1).attrs.block).toBe('whiteboard')
  })

  it('keeps the required first paragraph of a list item rather than replacing it', () => {
    const { state } = createEditor('- one')
    const tr = state.tr.delete(3, 6)
    const pos = findPos(tr.doc, (node) => node.type.name === 'paragraph') + 1
    const range = penInsertRange(tr.doc, pos)
    expect(range.from).toBe(range.to)
  })
})

describe('enclosingWhiteboard', () => {
  it('finds the innermost board around a position inside its body', () => {
    const { state } = createEditor('Intro\n\n' + BOARD)
    const textPos = findPos(state.doc, (node) => node.isText && node.text === EMPTY_WHITEBOARD_BODY)
    const found = enclosingWhiteboard(state.doc, textPos + 2)
    expect(found.node.attrs.block).toBe('whiteboard')
    expect(state.doc.nodeAt(found.pos)).toBe(found.node)
    expect(enclosingWhiteboard(state.doc, 2)).toBeNull()
  })
})

describe('pageWhiteboardBytes', () => {
  it('sums the trimmed body bytes of every board, nested ones included', () => {
    const { state } = createEditor(BOARD + '\n\n:::block-tabs\n::block-tab\n' + BOARD + '\n::\n:::')
    expect(pageWhiteboardBytes(state.doc)).toBe(EMPTY_WHITEBOARD_BODY.length * 2)
  })
})

describe('insertWhiteboard command', () => {
  it('serialises to the pinned ::block-whiteboard fence', () => {
    createEditor('')
    expect(editor.commands.insertWhiteboard()).toBe(true)
    expect(editor.getMarkdown().trim()).toBe(BOARD)
  })

  it('puts the caret on a new line after the board when another board follows it', () => {
    createEditor('Intro\n\n' + BOARD)
    const introEnd = findPos(editor.state.doc, (node) => node.isText && node.text === 'Intro') + 5
    editor.commands.setTextSelection(introEnd)

    expect(editor.commands.insertWhiteboard()).toBe(true)

    const { doc, selection } = editor.state
    expect(doc.child(1).attrs.block).toBe('whiteboard')
    expect(doc.child(2).type.name).toBe('paragraph')
    expect(doc.child(3).attrs.block).toBe('whiteboard')
    expect(selection.$head.depth).toBe(1)
    expect(selection.$head.index(0)).toBe(2)

    editor.commands.insertContent('typed')
    expect(editor.state.doc.child(2).textContent).toBe('typed')
    expect(editor.state.doc.child(3).textContent).toBe(EMPTY_WHITEBOARD_BODY)
  })

  it('reuses a line that already follows the board rather than adding another', () => {
    createEditor('Intro\n\nAfter')
    const introEnd = findPos(editor.state.doc, (node) => node.isText && node.text === 'Intro') + 5
    editor.commands.setTextSelection(introEnd)

    editor.commands.insertWhiteboard()

    const { doc, selection } = editor.state
    expect(doc.childCount).toBe(3)
    expect(selection.$head.parent.textContent).toBe('After')
    expect(selection.$head.parentOffset).toBe(0)
  })
})

describe('the empty board', () => {
  it('is a format 2 header line with no strokes', () => {
    expect(EMPTY_WHITEBOARD_BODY).toBe('{"v":2,"w":800,"h":450}')
  })
})

describe('appendedSuffix', () => {
  it('finds the text a new body adds after the current one', () => {
    expect(appendedSuffix('H', 'H\nS')).toEqual({ at: 1, text: '\nS' })
  })

  it('ends a first stroke on an empty fence with a line break, so two of them stay two lines', () => {
    expect(appendedSuffix('', 'H\nS')).toEqual({ at: 0, text: 'H\nS\n' })
    expect(appendedSuffix('\n', 'H\nS')).toEqual({ at: 1, text: 'H\nS\n' })
  })

  it('measures against the trimmed text the block reads, inserting before trailing whitespace', () => {
    expect(appendedSuffix('H\n', 'H\nS')).toEqual({ at: 1, text: '\nS' })
    expect(appendedSuffix('H  \n\n', 'H\nS')).toEqual({ at: 1, text: '\nS' })
    expect(appendedSuffix('\n  H\n', 'H\nS')).toEqual({ at: 4, text: '\nS' })
  })

  it('declines a body that does not extend the current one', () => {
    expect(appendedSuffix('H\nA', 'H\nB')).toBeNull()
    expect(appendedSuffix('H\nA', 'H')).toBeNull()
    expect(appendedSuffix('H\n', 'H')).toBeNull()
    expect(appendedSuffix('H', 'H')).toBeNull()
  })
})

describe('applyWhiteboardBody', () => {
  const STROKE = '{"c":"#1f2937","z":6,"p":[1,1,50]}'

  function boardTarget() {
    let target = null
    editor.state.doc.descendants((node, pos) => {
      if (!target && node.attrs?.block === 'whiteboard') {
        target = { node, pos }
      }
      return !target
    })
    return target
  }

  function capture() {
    const dispatched = []
    const dispatch = editor.view.dispatch.bind(editor.view)
    editor.view.dispatch = (tr) => {
      dispatched.push(tr)
      dispatch(tr)
    }
    return dispatched
  }

  function onlyStep(tr) {
    expect(tr.steps).toHaveLength(1)
    const { from, to, slice } = tr.steps[0].toJSON()
    return { from, to, text: slice?.content?.map((node) => node.text).join('') ?? '' }
  }

  it('inserts only the appended line at the end of the code block text', () => {
    createEditor(BOARD)
    const dispatched = capture()
    const target = boardTarget()
    const textEnd = target.pos + 2 + EMPTY_WHITEBOARD_BODY.length

    expect(applyWhiteboardBody(editor.view, target, EMPTY_WHITEBOARD_BODY + '\n' + STROKE)).toBe(
      true
    )

    expect(onlyStep(dispatched[0])).toEqual({ from: textEnd, to: textEnd, text: '\n' + STROKE })
    expect(whiteboardBodyOf(boardTarget().node)).toBe(EMPTY_WHITEBOARD_BODY + '\n' + STROKE)
  })

  it('appends before trailing whitespace in the code block, which the block never sees', () => {
    createEditor(BOARD)
    const start = boardTarget().pos + 2
    editor.view.dispatch(editor.state.tr.insertText('\n\n', start + EMPTY_WHITEBOARD_BODY.length))
    const dispatched = capture()

    applyWhiteboardBody(editor.view, boardTarget(), EMPTY_WHITEBOARD_BODY + '\n' + STROKE)

    const step = onlyStep(dispatched[0])
    expect(step.from).toBe(start + EMPTY_WHITEBOARD_BODY.length)
    expect(step.to).toBe(step.from)
    expect(whiteboardBodyOf(boardTarget().node)).toBe(
      EMPTY_WHITEBOARD_BODY + '\n' + STROKE + '\n\n'
    )
  })

  it('replaces the whole text when the new body is not an extension of the old', () => {
    createEditor(BOARD.replace(EMPTY_WHITEBOARD_BODY, EMPTY_WHITEBOARD_BODY + '\n' + STROKE))
    const dispatched = capture()

    applyWhiteboardBody(editor.view, boardTarget(), EMPTY_WHITEBOARD_BODY)

    const step = onlyStep(dispatched[0])
    expect(step.to).toBeGreaterThan(step.from)
    expect(whiteboardBodyOf(boardTarget().node)).toBe(EMPTY_WHITEBOARD_BODY)
  })

  it('reads and appends across every code block a board holds, as the block does', () => {
    createEditor(
      '::block-whiteboard\n```whiteboard\n' +
        EMPTY_WHITEBOARD_BODY +
        '\n' +
        STROKE +
        '\n```\n\n```whiteboard\n' +
        EMPTY_WHITEBOARD_BODY +
        '\n```\n::'
    )
    const current = EMPTY_WHITEBOARD_BODY + '\n' + STROKE + '\n' + EMPTY_WHITEBOARD_BODY
    expect(whiteboardBodyOf(boardTarget().node)).toBe(current)
    expect(pageWhiteboardBytes(editor.state.doc)).toBe(current.length)
    const dispatched = capture()

    applyWhiteboardBody(editor.view, boardTarget(), current + '\n' + STROKE)

    const step = onlyStep(dispatched[0])
    expect(step.text).toBe('\n' + STROKE)
    const { node } = boardTarget()
    expect(node.childCount).toBe(2)
    expect(node.child(1).textContent).toBe(EMPTY_WHITEBOARD_BODY + '\n' + STROKE)
  })

  it('folds a board back into one code block when it replaces the body', () => {
    createEditor(
      '::block-whiteboard\n```whiteboard\n' +
        EMPTY_WHITEBOARD_BODY +
        '\n' +
        STROKE +
        '\n```\n\n```whiteboard\n' +
        EMPTY_WHITEBOARD_BODY +
        '\n```\n::'
    )

    applyWhiteboardBody(editor.view, boardTarget(), EMPTY_WHITEBOARD_BODY)

    const { node } = boardTarget()
    expect(node.childCount).toBe(1)
    expect(whiteboardBodyOf(node)).toBe(EMPTY_WHITEBOARD_BODY)
  })

  it('still refuses a body with an unreadable header', () => {
    createEditor(BOARD)
    const refusals = []

    expect(
      applyWhiteboardBody(editor.view, boardTarget(), '{broken\n' + STROKE, (reason) =>
        refusals.push(reason)
      )
    ).toBe(false)
    expect(refusals).toEqual(['invalid'])
  })
})
