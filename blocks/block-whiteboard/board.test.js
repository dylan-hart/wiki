import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_SIZE,
  DEFAULT_WIDTH,
  MAX_SIDE,
  MAX_SIZE,
  MIN_SIZE,
  exceedsCap,
  measureBoard,
  outlineToPath,
  parseBoard,
  safeColor,
  serializeBoard,
  strokePath,
  utf8Length
} from './board.js'
import { MAX_BLOCK_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

const PATH_ALPHABET = /^[MQTLZ0-9., -]*$/

function body(board) {
  return JSON.stringify({ v: 1, w: 800, h: 450, ...board })
}

describe('block-whiteboard board format', () => {
  it('reads an empty body as an empty board of the default size', () => {
    expect(parseBoard('')).toEqual({
      board: { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT, s: [] }
    })
    expect(parseBoard('   \n ')).toEqual({
      board: { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT, s: [] }
    })
  })

  it('reads the pinned format and writes it back byte for byte', () => {
    const source = '{"v":1,"w":640,"h":360,"s":[{"c":"#3366cc","z":4,"p":[10,20,50,30,40,80]}]}'
    const { board } = parseBoard(source)

    expect(board).toEqual({
      w: 640,
      h: 360,
      s: [{ c: '#3366cc', z: 4, p: [10, 20, 50, 30, 40, 80] }]
    })
    expect(serializeBoard(board)).toBe(source)
  })

  it('accepts a body with no version field, and refuses any other version', () => {
    expect(parseBoard('{"s":[]}').board).toBeDefined()
    expect(parseBoard('{"v":2,"s":[]}')).toEqual({ error: 'version', version: '2' })
    expect(parseBoard('{"v":"1","s":[]}')).toMatchObject({ error: 'version' })
  })

  it('refuses a body that is not the board shape', () => {
    for (const source of [
      '{not json',
      'null',
      '[]',
      '"a string"',
      '42',
      '{"s":"strokes"}',
      '{"s":[null]}',
      '{"s":[[1,2,3]]}',
      '{"s":[{"c":"#000"}]}',
      '{"s":[{"p":"1,2,3"}]}'
    ]) {
      expect(parseBoard(source), source).toEqual({ error: 'invalid' })
    }
  })

  it('counts points as whole triples and drops a trailing partial one', () => {
    const { board } = parseBoard(body({ s: [{ c: '#000', z: 2, p: [1, 2, 3, 4, 5] }] }))

    expect(board.s[0].p).toEqual([1, 2, 3])
    expect(measureBoard(board)).toEqual({ strokes: 1, points: 1 })
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
        '{"v":1,"w":1e999,"h":-5,"s":[{"c":"#000","z":1e308,"p":[-1e308,1e308,500,"12",null,-3,{"x":1},[],"NaN"]},' +
        '{"c":"#000","z":"9","p":[1,2,3]},{"c":"#000","z":-4,"p":[]}]}'
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
      expect(parseBoard('{"w":100000,"h":100000,"s":[]}').board).toMatchObject({
        w: MAX_SIDE,
        h: MAX_SIDE
      })
    })

    it('ignores unknown and prototype-polluting keys', () => {
      const { board } = parseBoard(
        '{"__proto__":{"polluted":true},"constructor":1,"s":[{"__proto__":{"c":"red"},"p":[1,1,1],"extra":"<svg>"}]}'
      )

      expect({}.polluted).toBeUndefined()
      expect(board.s[0]).toEqual({ c: DEFAULT_COLOR, z: DEFAULT_SIZE, p: [1, 1, 1] })
      expect(serializeBoard(board)).not.toContain('extra')
    })

    it('builds a path out of numbers and path commands alone', () => {
      const { board } = parseBoard(
        '{"s":[{"c":"\\"/><script>","z":3,"p":[10,10,50,20,30,90,40,20,10,80,90,100]}]}'
      )
      const d = strokePath(board.s[0])

      expect(d).toMatch(PATH_ALPHABET)
      expect(d.startsWith('M')).toBe(true)
    })
  })

  describe('size cap', () => {
    it('refuses a body over the byte cap before parsing it', () => {
      const padding = 'x'.repeat(MAX_BLOCK_BYTES)
      expect(parseBoard(`{"pad":"${padding}","s":[]}`)).toEqual({ error: 'tooLarge' })
    })

    it('measures UTF-8 bytes, not UTF-16 code units', () => {
      expect(utf8Length('é')).toBe(2)
      expect(utf8Length('✏️')).toBe(6)
      const padding = 'é'.repeat(MAX_BLOCK_BYTES / 2)
      expect(parseBoard(`{"pad":"${padding}","s":[]}`)).toEqual({ error: 'tooLarge' })
    })

    it('refuses more strokes than the cap', () => {
      const strokes = Array.from({ length: MAX_STROKES + 1 }, () => ({ p: [] }))
      expect(parseBoard(body({ s: strokes }))).toEqual({ error: 'tooLarge' })

      const atCap = Array.from({ length: MAX_STROKES }, () => ({ p: [] }))
      expect(parseBoard(body({ s: atCap })).board.s).toHaveLength(MAX_STROKES)
    })

    it('refuses more points than the cap', () => {
      const over = { p: Array.from({ length: (MAX_POINTS + 1) * 3 }, () => 1) }
      expect(parseBoard(body({ s: [over] }))).toEqual({ error: 'tooLarge' })
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
