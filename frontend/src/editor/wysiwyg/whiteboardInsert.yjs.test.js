import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

import { WikiBlock } from './wikiBlockNode'
import {
  EMPTY_WHITEBOARD_BODY,
  WhiteboardInsert,
  applyWhiteboardBody,
  isWhiteboardNode,
  whiteboardBodyOf
} from './whiteboardInsert'

const editors = []

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

function strokeLine(seed) {
  return JSON.stringify({ c: '#1f2937', z: 6, p: [seed, seed, 50, seed + 10, seed + 5, 60] })
}

function boardBody(...seeds) {
  return [EMPTY_WHITEBOARD_BODY, ...seeds.map(strokeLine)].join('\n')
}

function boardMarkdown(body) {
  return '::block-whiteboard\n```whiteboard\n' + body + '\n```\n::'
}

function createReplica(doc) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Markdown,
      WikiBlock,
      WhiteboardInsert,
      Collaboration.configure({ fragment: doc.getXmlFragment('wysiwygBody') })
    ]
  })
  editors.push(editor)
  return editor
}

function sync(from, to) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
}

function exchange(a, b) {
  sync(a, b)
  sync(b, a)
}

function findBoard(editor) {
  let found = null
  editor.state.doc.descendants((node, pos) => {
    if (!found && isWhiteboardNode(node)) {
      found = { node, pos }
    }
    return !found
  })
  return found
}

function bodyOn(editor) {
  return whiteboardBodyOf(findBoard(editor).node)
}

function withStroke(editor, seed) {
  return `${bodyOn(editor).trim()}\n${strokeLine(seed)}`
}

function apply(editor, body) {
  const refusals = []
  const applied = applyWhiteboardBody(editor.view, findBoard(editor), body, (reason) =>
    refusals.push(reason)
  )
  expect(refusals).toEqual([])
  expect(applied).toBe(true)
}

function readBoard(body) {
  const [header, ...lines] = body.trim().split('\n')
  return {
    header: JSON.parse(header),
    strokes: lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  }
}

function seedPair(body) {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const a = createReplica(docA)
  a.commands.setContent(boardMarkdown(body), { contentType: 'markdown' })
  const b = createReplica(docB)
  exchange(docA, docB)
  expect(bodyOn(b)).toBe(bodyOn(a))
  return { a, b, docA, docB }
}

function expectConverged(a, b, seeds) {
  const body = bodyOn(a)
  expect(bodyOn(b)).toBe(body)
  const board = readBoard(body)
  expect(board.header).toEqual(JSON.parse(EMPTY_WHITEBOARD_BODY))
  expect(board.strokes.map((stroke) => stroke.p[0]).sort((x, y) => x - y)).toEqual(
    [...seeds].sort((x, y) => x - y)
  )
}

describe('applyWhiteboardBody under Yjs collaboration', () => {
  it('merges two first strokes drawn at once on an empty board into a readable board', () => {
    const { a, b, docA, docB } = seedPair(EMPTY_WHITEBOARD_BODY)

    apply(a, withStroke(a, 100))
    apply(b, withStroke(b, 200))
    exchange(docA, docB)

    expectConverged(a, b, [100, 200])
  })

  it('merges two strokes drawn at once on a board that already has one', () => {
    const { a, b, docA, docB } = seedPair(boardBody(10))

    apply(a, withStroke(a, 100))
    apply(b, withStroke(b, 200))
    exchange(docA, docB)

    expectConverged(a, b, [10, 100, 200])
  })

  it('keeps a new stroke when the other replica removes its last stroke at the same time', () => {
    const { a, b, docA, docB } = seedPair(boardBody(10, 20))

    apply(a, withStroke(a, 100))
    apply(b, boardBody(10))
    exchange(docA, docB)

    expectConverged(a, b, [10, 100])
  })

  it('takes the append path when the code block ends in whitespace the block trims away', () => {
    for (const tail of ['\n', '\n\n', '  ']) {
      const { a, b, docA, docB } = seedPair(boardBody(10))
      const { node, pos } = findBoard(a)
      const end = pos + 1 + node.firstChild.nodeSize - 1
      a.view.dispatch(a.state.tr.insertText(tail, end))
      exchange(docA, docB)
      expect(bodyOn(b)).toBe(boardBody(10) + tail)

      apply(a, withStroke(a, 100))
      apply(b, withStroke(b, 200))
      exchange(docA, docB)

      expectConverged(a, b, [10, 100, 200])
    }
  })

  it('undoes each replica’s own stroke, and only that, when both undo at once', () => {
    const { a, b, docA, docB } = seedPair(boardBody(10))

    apply(a, withStroke(a, 100))
    apply(b, withStroke(b, 200))
    exchange(docA, docB)
    expectConverged(a, b, [10, 100, 200])

    expect(a.commands.undo()).toBe(true)
    exchange(docA, docB)
    expectConverged(a, b, [10, 200])

    apply(a, withStroke(a, 300))
    expect(b.commands.undo()).toBe(true)
    exchange(docA, docB)
    expectConverged(a, b, [10, 300])
  })
})
