import { describe, expect, it } from 'vitest'

import { countWhiteboardStrokes } from '../../backend/helpers/whiteboardLimits.ts'
import { measureWhiteboardBody } from '../../frontend/src/helpers/whiteboardLimits.js'
import { measureBody, parseBoard } from './board.js'
import { MAX_BLOCK_BYTES, MAX_PAGE_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

const HEADER = '{"v":2,"w":800,"h":450}'

function counts(body) {
  const block = measureBody(body)
  const editor = measureWhiteboardBody(body)
  const server = countWhiteboardStrokes(body)
  return {
    block: { strokes: block.strokes, points: block.points },
    editor: { strokes: editor.strokes, points: editor.points },
    server
  }
}

describe('block-whiteboard size cap', () => {
  it('holds the pinned literal numbers the backend and frontend copies share', () => {
    expect(MAX_BLOCK_BYTES).toBe(262144)
    expect(MAX_STROKES).toBe(2000)
    expect(MAX_POINTS).toBe(50000)
    expect(MAX_PAGE_BYTES).toBe(1048576)
  })
})

describe('the three cap counters agree', () => {
  it.each([
    ['an empty body', ''],
    ['a header alone', HEADER],
    ['two strokes', `${HEADER}\n{"c":"#000","z":2,"p":[1,1,1,2,2,2]}\n{"p":[3,3,3]}`],
    [
      'a corrupt stroke line among good ones',
      [
        HEADER,
        '{"c":"#000","z":2,"p":[1,1,1,2,2,2]}',
        '{"c":"#000","z":2,"p":[1,1',
        '',
        '{"c":"#000","z":2}',
        'null',
        '[1,2,3]',
        '{"c":"#000","z":2,"p":[3,3,3,4,4,4,5,5,5,6]}'
      ].join('\n')
    ],
    ['padding and CRLF line ends', `\n  ${HEADER}\r\n{"p":[1,2,3]}\r\n\r\n{broken\r\n  `],
    ['an unreadable header', '{not json\n{"p":[1,2,3]}\n{"p":[4,5,6]}']
  ])('on %s', (_label, body) => {
    const { block, editor, server } = counts(body)
    expect(editor).toEqual(block)
    expect(server).toEqual(block)
  })

  it('counts a corrupt line as a stroke with no points, which the parser drops', () => {
    const body = `${HEADER}\n{"p":[1,1,1]}\n{"p":[1,1\n{"p":[2,2,2,3,3,3]}`

    expect(counts(body).block).toEqual({ strokes: 3, points: 3 })
    expect(parseBoard(body)).toMatchObject({ dropped: 1 })
    expect(parseBoard(body).board.s).toHaveLength(2)
  })

  it('refuses the same stroke count at the cap in all three', () => {
    const lines = Array.from({ length: MAX_STROKES }, () => '{"p":[1,1,1]}')
    const body = [HEADER, ...lines, '{broken'].join('\n')

    expect(counts(body).block.strokes).toBe(MAX_STROKES + 1)
    expect(counts(body).editor.strokes).toBe(MAX_STROKES + 1)
    expect(counts(body).server.strokes).toBe(MAX_STROKES + 1)
    expect(parseBoard(body)).toEqual({ error: 'tooLarge' })
  })
})
