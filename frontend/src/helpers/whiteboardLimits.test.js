import { describe, expect, it } from 'vitest'

import {
  WHITEBOARD_MAX_BLOCK_BYTES,
  WHITEBOARD_MAX_PAGE_BYTES,
  WHITEBOARD_MAX_POINTS,
  WHITEBOARD_MAX_STROKES,
  measureWhiteboardBody,
  utf8ByteLength,
  whiteboardBodyBytes,
  whiteboardBodyRefusal
} from './whiteboardLimits'

const HEADER = '{"v":2,"w":800,"h":450}'

function board(strokes, header = HEADER) {
  return [header, ...strokes.map((s) => JSON.stringify(s))].join('\n')
}

function stroke(pointCount) {
  const p = []
  for (let i = 0; i < pointCount; i++) {
    p.push(i, i, 50)
  }
  return { c: '#000000', z: 4, p }
}

describe('whiteboard size cap constants', () => {
  it('pins the literal numbers shared with blocks/ and backend/', () => {
    expect(WHITEBOARD_MAX_BLOCK_BYTES).toBe(262144)
    expect(WHITEBOARD_MAX_STROKES).toBe(2000)
    expect(WHITEBOARD_MAX_POINTS).toBe(50000)
    expect(WHITEBOARD_MAX_PAGE_BYTES).toBe(1048576)
  })
})

describe('measureWhiteboardBody', () => {
  it('counts one stroke per line and floor(p.length / 3) points per stroke', () => {
    const body = board([stroke(3), { c: '#fff', z: 1, p: [1, 2, 3, 4, 5] }])
    expect(measureWhiteboardBody(body)).toEqual({
      bytes: utf8ByteLength(body),
      strokes: 2,
      points: 4,
      valid: true
    })
  })

  it('treats a header line alone as a valid empty board', () => {
    expect(measureWhiteboardBody(HEADER)).toMatchObject({ strokes: 0, points: 0, valid: true })
  })

  it('counts a line that does not parse as a stroke, with no points', () => {
    const body = [
      HEADER,
      '{"c":"#000","z":2,"p":[1,1,1,2,2,2]}',
      '',
      '{"c":"#000","z":2,"p":[1,1',
      '{"c":"#000","z":2}',
      '{"c":"#000","z":2,"p":[3,3,3,4,4,4,5,5,5]}'
    ].join('\n')
    expect(measureWhiteboardBody(body)).toEqual({
      bytes: utf8ByteLength(body),
      strokes: 4,
      points: 5,
      valid: true
    })
  })

  it('measures UTF-8 bytes of the trimmed text, not UTF-16 length', () => {
    expect(whiteboardBodyBytes('  é  \n')).toBe(2)
  })

  it('marks a body whose header line is not an object invalid', () => {
    expect(measureWhiteboardBody('{not json').valid).toBe(false)
    expect(measureWhiteboardBody('null\n{"p":[1,1,1]}').valid).toBe(false)
    expect(measureWhiteboardBody('[]').valid).toBe(false)
    expect(measureWhiteboardBody('').valid).toBe(false)
  })
})

describe('whiteboardBodyRefusal', () => {
  it('accepts a body exactly at the stroke cap', () => {
    const strokes = Array.from({ length: WHITEBOARD_MAX_STROKES }, () => ({ p: [] }))
    expect(whiteboardBodyRefusal(board(strokes))).toBeNull()
  })

  it('refuses one stroke too many, counting a damaged line as a stroke', () => {
    const strokes = Array.from({ length: WHITEBOARD_MAX_STROKES + 1 }, () => ({ p: [] }))
    expect(whiteboardBodyRefusal(board(strokes))).toBe('strokes')

    const atCap = Array.from({ length: WHITEBOARD_MAX_STROKES }, () => ({ p: [] }))
    expect(whiteboardBodyRefusal(board(atCap) + '\n{broken')).toBe('strokes')
  })

  it('refuses one point too many', () => {
    const p = Array.from({ length: (WHITEBOARD_MAX_POINTS + 1) * 3 }, () => 0)
    expect(whiteboardBodyRefusal(board([{ c: '#000', z: 1, p }]))).toBe('points')
  })

  it('accepts a body exactly at the byte cap and refuses one byte more', () => {
    const base = JSON.stringify({ v: 2, w: 800, h: 450, pad: '' })
    const atCap = JSON.stringify({
      v: 2,
      w: 800,
      h: 450,
      pad: 'x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES - utf8ByteLength(base))
    })
    expect(whiteboardBodyBytes(atCap)).toBe(WHITEBOARD_MAX_BLOCK_BYTES)
    expect(whiteboardBodyRefusal(atCap)).toBeNull()
    expect(whiteboardBodyRefusal(atCap.replace('"pad":"', '"pad":"x'))).toBe('blockBytes')
  })

  it('refuses an unparseable header, but not a damaged stroke line', () => {
    expect(whiteboardBodyRefusal('{')).toBe('invalid')
    expect(whiteboardBodyRefusal(HEADER + '\n{broken')).toBeNull()
  })
})
