import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  assertNoteContentWithinCap,
  NOTE_MAX_CONTENT_BYTES,
  whiteboardBodiesInMarkdown
} from './noteContent.ts'
import {
  WHITEBOARD_MAX_BLOCK_BYTES,
  WHITEBOARD_MAX_PAGE_BYTES,
  WHITEBOARD_MAX_STROKES
} from './whiteboardLimits.ts'

const EMPTY_BOARD = '{"v":2,"w":800,"h":450}'
const DRAWN_BOARD =
  '{"v":2,"w":800,"h":450}\n{"c":"#1f2937","z":6,"p":[1,1,50]}\n{"c":"#1f2937","z":6,"p":[2,2,50]}'

function board(body: string, indent = ''): string {
  return [
    `${indent}::block-whiteboard`,
    `${indent}\`\`\`whiteboard`,
    ...body.split('\n').map((l) => `${indent}${l}`),
    `${indent}\`\`\``,
    `${indent}::`
  ].join('\n')
}

function thrown(fn: () => void): any {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

describe('whiteboardBodiesInMarkdown', () => {
  test('finds the body of each whiteboard block fence', () => {
    const md = `# Title\n\nSome text\n\n${board(EMPTY_BOARD)}\n\nMore\n\n${board(DRAWN_BOARD)}\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [EMPTY_BOARD, DRAWN_BOARD])
  })

  test('finds a bare whiteboard fence and a tilde fence', () => {
    const md = '```whiteboard\nA\n```\n\n~~~~ whiteboard\nB\n~~~~\n'

    assert.deepEqual(whiteboardBodiesInMarkdown(md), ['A', 'B'])
  })

  test('ignores other code fences, including one that quotes a whiteboard fence', () => {
    const md = '````markdown\n```whiteboard\nquoted\n```\n````\n\n```js\nconst a = 1\n```\n'

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [])
  })

  test('strips the indentation of a whiteboard nested in a list item', () => {
    const md = `- item\n\n${board(DRAWN_BOARD, '  ')}\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [DRAWN_BOARD])
  })

  test('an unclosed whiteboard fence still counts, up to the end of the note', () => {
    assert.deepEqual(whiteboardBodiesInMarkdown('```whiteboard\nA\nB'), ['A\nB'])
  })

  test('handles CRLF line endings', () => {
    assert.deepEqual(whiteboardBodiesInMarkdown('```whiteboard\r\nA\r\n```\r\n'), ['A'])
  })
})

describe('assertNoteContentWithinCap', () => {
  test('accepts ordinary content with a whiteboard inside the caps', () => {
    assert.doesNotThrow(() => assertNoteContentWithinCap(`Hello\n\n${board(EMPTY_BOARD)}`))
    assert.doesNotThrow(() => assertNoteContentWithinCap(''))
  })

  test('refuses content over the note byte cap with 413', () => {
    const err = thrown(() => assertNoteContentWithinCap('x'.repeat(NOTE_MAX_CONTENT_BYTES + 1)))

    assert.equal(err?.name, 'noteContentTooLarge')
    assert.equal(err?.statusCode, 413)
  })

  test('refuses a whiteboard over the one-board byte cap', () => {
    const err = thrown(() =>
      assertNoteContentWithinCap(board('x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES + 1)))
    )

    assert.equal(err?.name, 'noteWhiteboardTooLarge')
    assert.equal(err?.statusCode, 400)
    assert.match(err.message, /in this note/)
  })

  test('refuses whiteboards whose total passes the per-note cap', () => {
    const one = 'x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES)
    const count = Math.floor(WHITEBOARD_MAX_PAGE_BYTES / WHITEBOARD_MAX_BLOCK_BYTES) + 1
    const md = Array.from({ length: count }, () => board(one)).join('\n\n')

    const err = thrown(() => assertNoteContentWithinCap(md))

    assert.equal(err?.name, 'noteWhiteboardTooLarge')
    assert.match(err.message, /total/)
  })

  test('refuses a whiteboard with too many strokes', () => {
    const strokes = Array.from({ length: WHITEBOARD_MAX_STROKES + 1 }, () => '{"p":[]}')
    const err = thrown(() =>
      assertNoteContentWithinCap(board([EMPTY_BOARD, ...strokes].join('\n')))
    )

    assert.equal(err?.name, 'noteWhiteboardTooLarge')
    assert.match(err.message, /strokes/)
  })
})
