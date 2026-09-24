import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { whiteboardBodiesInMarkdown } from './whiteboardMarkdown.ts'

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

function quote(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
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

describe('whiteboardBodiesInMarkdown: what the renderer reads, not what a line scan sees', () => {
  test('finds a board inside a quote and inside an alert', () => {
    const md = `${quote(board(DRAWN_BOARD))}\n\n> [!NOTE]\n${quote(board(EMPTY_BOARD))}\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [DRAWN_BOARD, EMPTY_BOARD])
  })

  test('is not fooled by a four-space-indented line of backticks, which is code', () => {
    const md = `para\n\n    \`\`\`\n\n${board(DRAWN_BOARD)}\n\n    \`\`\`\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [DRAWN_BOARD])
  })

  test('reads the first fence in a board whatever its language, as the block does', () => {
    const md = `::block-whiteboard\n\`\`\`json\n${DRAWN_BOARD}\n\`\`\`\n::\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [DRAWN_BOARD])
  })

  test('joins every fence in one board, and reads a board with none by its text', () => {
    const two = '::block-whiteboard\n```whiteboard\nA\n```\n\n```whiteboard\nB\n```\n::\n'
    const bare = `::block-whiteboard\n${EMPTY_BOARD}\n::\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(two), ['A\n\nB'])
    assert.deepEqual(whiteboardBodiesInMarkdown(bare), [EMPTY_BOARD])
  })

  test('reads a board nested in another block, and leaves other blocks alone', () => {
    const md = `:::block-tabs\n::block-tab{label="One"}\n${board(DRAWN_BOARD)}\n::\n:::\n\n::block-diagram\n\`\`\`mermaid\ngraph TD\n\`\`\`\n::\n`

    assert.deepEqual(whiteboardBodiesInMarkdown(md), [DRAWN_BOARD])
  })
})
