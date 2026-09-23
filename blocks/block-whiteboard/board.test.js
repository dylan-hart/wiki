import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_SIZE,
  DEFAULT_WIDTH,
  FORMAT_VERSION,
  MAX_SIDE,
  MAX_SIZE,
  MIN_SIZE,
  appendStroke,
  exceedsCap,
  measureBody,
  outlineToPath,
  parseBoard,
  safeColor,
  serializeBoard,
  strokePath,
  utf8Length
} from './board.js'
import { MAX_BLOCK_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

const PATH_ALPHABET = /^[MQTLZ0-9., -]*$/
const HEADER = '{"v":2,"w":800,"h":450}'

function body(strokes, header = HEADER) {
  return [header, ...strokes.map((stroke) => JSON.stringify(stroke))].join('\n')
}

describe('block-whiteboard board format', () => {
  it('is format version 2', () => {
    expect(FORMAT_VERSION).toBe(2)
  })

  it('reads an empty body as an empty board of the default size', () => {
    for (const source of ['', '   \n ', null, undefined]) {
      expect(parseBoard(source)).toEqual({
        board: { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT, s: [] },
        dropped: 0
      })
    }
  })

  it('reads a header line alone as an empty board', () => {
    expect(parseBoard('{"v":2,"w":640,"h":360}')).toEqual({
      board: { w: 640, h: 360, s: [] },
      dropped: 0
    })
  })

  it('reads the pinned format, one stroke per line, and writes it back byte for byte', () => {
    const source =
      '{"v":2,"w":640,"h":360}\n' +
      '{"c":"#3366cc","z":4,"p":[10,20,50,30,40,80]}\n' +
      '{"c":"#000000","z":6,"p":[1,2,3]}'
    const { board, dropped } = parseBoard(source)

    expect(board).toEqual({
      w: 640,
      h: 360,
      s: [
        { c: '#3366cc', z: 4, p: [10, 20, 50, 30, 40, 80] },
        { c: '#000000', z: 6, p: [1, 2, 3] }
      ]
    })
    expect(dropped).toBe(0)
    expect(serializeBoard(board)).toBe(source)
  })

  it('writes an empty board as its header line alone', () => {
    expect(serializeBoard({ w: 800, h: 450, s: [] })).toBe(HEADER)
  })

  it('appends a stroke as one new line, leaving the source before it untouched', () => {
    const source = HEADER + '\n{"c":"#000","z":2,"p":[1,1,1]}\n{broken'
    const next = appendStroke(source, { c: '#3366cc', z: 4, p: [5, 6, 7], extra: 'x' })

    expect(next).toBe(source + '\n{"c":"#3366cc","z":4,"p":[5,6,7]}')
    expect(next.startsWith(source)).toBe(true)
    expect(parseBoard(next)).toMatchObject({ dropped: 1 })
    expect(parseBoard(next).board.s).toHaveLength(2)
  })

  it('ignores blank lines and CRLF line ends between strokes', () => {
    const source =
      HEADER + '\r\n\r\n{"c":"#000","z":2,"p":[1,1,1]}\r\n   \n{"c":"#000","z":2,"p":[2,2,2]}'
    const { board, dropped } = parseBoard(source)

    expect(board.s.map((stroke) => stroke.p[0])).toEqual([1, 2])
    expect(dropped).toBe(0)
  })

  it('needs a version on the header, and refuses any version but its own', () => {
    expect(parseBoard('{"w":800,"h":450}')).toEqual({ error: 'invalid' })
    expect(parseBoard('{"v":1,"w":800,"h":450,"s":[]}')).toEqual({ error: 'version', version: '1' })
    expect(parseBoard('{"v":3}\n{"c":"#000","z":2,"p":[1,1,1]}')).toEqual({
      error: 'version',
      version: '3'
    })
    expect(parseBoard('{"v":"2"}')).toMatchObject({ error: 'version' })
  })

  it('refuses the whole board when its header line is not a board header', () => {
    for (const header of [
      '{not json',
      'null',
      '[]',
      '"a string"',
      '42',
      '{"c":"#000","p":[1,1,1]}'
    ]) {
      const source = body([{ c: '#000', z: 2, p: [1, 1, 1] }], header)
      expect(parseBoard(source), header).toEqual({ error: 'invalid' })
    }
  })

  it('skips a stroke line it cannot read, keeps every other stroke, and counts what it dropped', () => {
    const good = (n) => JSON.stringify({ c: '#000000', z: 2, p: [n, n, 50] })
    const source = [HEADER, good(1), '{"c":"#000","z":2,"p":[1,1', good(2), good(3)].join('\n')
    const { board, dropped } = parseBoard(source)

    expect(board.s.map((stroke) => stroke.p[0])).toEqual([1, 2, 3])
    expect(dropped).toBe(1)
  })

  it('drops every kind of stroke line that is not a stroke object with a point array', () => {
    const lines = [
      '{not json',
      'null',
      '[1,2,3]',
      '"a string"',
      '42',
      '{"c":"#000"}',
      '{"p":"1,2,3"}',
      '{"v":2,"w":800,"h":450}'
    ]
    const source = [HEADER, '{"c":"#000000","z":2,"p":[9,9,9]}', ...lines].join('\n')
    const { board, dropped } = parseBoard(source)

    expect(board.s).toEqual([{ c: '#000000', z: 2, p: [9, 9, 9] }])
    expect(dropped).toBe(lines.length)
  })

  it('counts points as whole triples and drops a trailing partial one', () => {
    const source = body([{ c: '#000', z: 2, p: [1, 2, 3, 4, 5] }])

    expect(parseBoard(source).board.s[0].p).toEqual([1, 2, 3])
    expect(measureBody(source)).toEqual({ bytes: utf8Length(source), strokes: 1, points: 1 })
  })

  describe('measureBody', () => {
    it('counts every non-blank line after the header as a stroke, even one that does not parse', () => {
      const source = [
        HEADER,
        '{"c":"#000","z":2,"p":[1,1,1,2,2,2]}',
        '',
        '{"c":"#000","z":2,"p":[1,1',
        '{"c":"#000","z":2}',
        '{"c":"#000","z":2,"p":[3,3,3,4,4,4,5,5,5]}'
      ].join('\n')

      expect(measureBody(source)).toEqual({ bytes: utf8Length(source), strokes: 4, points: 5 })
    })

    it('measures an empty body and a header alone as no strokes at all', () => {
      expect(measureBody('')).toEqual({ bytes: 0, strokes: 0, points: 0 })
      expect(measureBody(`  ${HEADER}\n `)).toEqual({ bytes: HEADER.length, strokes: 0, points: 0 })
    })
  })

  describe('hostile JSON', () => {
    it('replaces any colour that is not a strict #hex with the default ink', () => {
      for (const c of [
        'red',
        '#12',
        '#1234',
        '#12345g',
        '#123456 ',
        '#123456"/><script>alert(1)</script>',
        'url(javascript:alert(1))',
        '',
        null,
        42,
        { toString: '#fff' }
      ]) {
        expect(safeColor(c), JSON.stringify(c)).toBe(DEFAULT_COLOR)
      }
      expect(safeColor('#abc')).toBe('#abc')
      expect(safeColor('#A1B2C3')).toBe('#A1B2C3')
    })

    it('clamps every number to a finite value inside the board', () => {
      const source =
        '{"v":2,"w":1e999,"h":-5}\n' +
        '{"c":"#000","z":1e308,"p":[-1e308,1e308,500,"12",null,-3,{"x":1},[],"NaN"]}\n' +
        '{"c":"#000","z":"9","p":[1,2,3]}\n' +
        '{"c":"#000","z":-4,"p":[]}'
      const { board } = parseBoard(source)

      expect(board.w).toBe(DEFAULT_WIDTH)
      expect(board.h).toBe(16)
      expect(board.s[0].z).toBe(MAX_SIZE)
      expect(board.s[0].p).toEqual([0, 16, 100, 0, 0, 0, 0, 0, 50])
      expect(board.s[1].z).toBe(DEFAULT_SIZE)
      expect(board.s[2].z).toBe(MIN_SIZE)
      for (const n of board.s.flatMap((s) => s.p)) {
        expect(Number.isInteger(n)).toBe(true)
      }
    })

    it('keeps a huge board side within the maximum', () => {
      expect(parseBoard('{"v":2,"w":100000,"h":100000}').board).toMatchObject({
        w: MAX_SIDE,
        h: MAX_SIDE
      })
    })

    it('ignores unknown and prototype-polluting keys', () => {
      const { board } = parseBoard(
        '{"v":2,"__proto__":{"polluted":true},"constructor":1}\n' +
          '{"__proto__":{"c":"red"},"p":[1,1,1],"extra":"<svg>"}'
      )

      expect({}.polluted).toBeUndefined()
      expect(board.s[0]).toEqual({ c: DEFAULT_COLOR, z: DEFAULT_SIZE, p: [1, 1, 1] })
      expect(serializeBoard(board)).not.toContain('extra')
      expect(serializeBoard(board)).not.toContain('polluted')
    })

    it('builds a path out of numbers and path commands alone', () => {
      const { board } = parseBoard(
        '{"v":2}\n{"c":"\\"/><script>","z":3,"p":[10,10,50,20,30,90,40,20,10,80,90,100]}'
      )
      const d = strokePath(board.s[0])

      expect(d).toMatch(PATH_ALPHABET)
      expect(d.startsWith('M')).toBe(true)
    })
  })

  describe('size cap', () => {
    it('refuses a body over the byte cap before parsing it', () => {
      const padding = 'x'.repeat(MAX_BLOCK_BYTES)
      expect(parseBoard(`{"v":2,"pad":"${padding}"}`)).toEqual({ error: 'tooLarge' })
    })

    it('measures UTF-8 bytes, not UTF-16 code units', () => {
      expect(utf8Length('é')).toBe(2)
      expect(utf8Length('✏️')).toBe(6)
      const padding = 'é'.repeat(MAX_BLOCK_BYTES / 2)
      expect(parseBoard(`{"v":2,"pad":"${padding}"}`)).toEqual({ error: 'tooLarge' })
    })

    it('refuses more strokes than the cap', () => {
      const strokes = Array.from({ length: MAX_STROKES + 1 }, () => ({ p: [] }))
      expect(parseBoard(body(strokes))).toEqual({ error: 'tooLarge' })

      const atCap = Array.from({ length: MAX_STROKES }, () => ({ p: [] }))
      expect(parseBoard(body(atCap)).board.s).toHaveLength(MAX_STROKES)
    })

    it('counts a stroke line it cannot read toward the stroke cap', () => {
      const lines = [HEADER, ...Array.from({ length: MAX_STROKES }, () => '{"p":[]}'), '{broken']
      expect(parseBoard(lines.join('\n'))).toEqual({ error: 'tooLarge' })
    })

    it('refuses more points than the cap', () => {
      const over = { p: Array.from({ length: (MAX_POINTS + 1) * 3 }, () => 1) }
      expect(parseBoard(body([over]))).toEqual({ error: 'tooLarge' })
    })

    it('exceedsCap is true past any one of the three limits', () => {
      const ok = { bytes: MAX_BLOCK_BYTES, strokes: MAX_STROKES, points: MAX_POINTS }
      expect(exceedsCap(ok)).toBe(false)
      expect(exceedsCap({ ...ok, bytes: MAX_BLOCK_BYTES + 1 })).toBe(true)
      expect(exceedsCap({ ...ok, strokes: MAX_STROKES + 1 })).toBe(true)
      expect(exceedsCap({ ...ok, points: MAX_POINTS + 1 })).toBe(true)
    })
  })

  describe('outlineToPath', () => {
    it('draws nothing for fewer than two outline points', () => {
      expect(outlineToPath([])).toBe('')
      expect(outlineToPath([[1, 2]])).toBe('')
    })

    it('writes a non-finite outline coordinate as 0', () => {
      expect(
        outlineToPath([
          [Number.NaN, 1],
          [2, Number.POSITIVE_INFINITY]
        ])
      ).toBe('M0,1 L2,0 Z')
    })

    it('draws a single-point stroke as a dot', () => {
      expect(strokePath({ c: '#000', z: 6, p: [100, 100, 50] })).toMatch(/^M.+Z$/)
    })
  })
})
