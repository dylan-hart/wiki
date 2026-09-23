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

function board(strokes) {
  return JSON.stringify({ v: 1, w: 800, h: 450, s: strokes })
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
  it('counts strokes and floor(p.length / 3) points per stroke', () => {
    const body = board([stroke(3), { c: '#fff', z: 1, p: [1, 2, 3, 4, 5] }])
    expect(measureWhiteboardBody(body)).toEqual({
      bytes: utf8ByteLength(body),
      strokes: 2,
      points: 4,
      valid: true
    })
  })

  it('treats an empty board as valid', () => {
    expect(measureWhiteboardBody(board([]))).toMatchObject({ strokes: 0, points: 0, valid: true })
  })

  it('measures UTF-8 bytes of the trimmed text, not UTF-16 length', () => {
    expect(whiteboardBodyBytes('  é  \n')).toBe(2)
  })

  it('marks unparseable or shapeless bodies invalid', () => {
    expect(measureWhiteboardBody('{not json').valid).toBe(false)
    expect(measureWhiteboardBody('{"v":1}').valid).toBe(false)
    expect(measureWhiteboardBody('null').valid).toBe(false)
  })
})

describe('whiteboardBodyRefusal', () => {
  it('accepts a body exactly at the stroke cap', () => {
    const strokes = Array.from({ length: WHITEBOARD_MAX_STROKES }, () => ({ p: [] }))
    expect(whiteboardBodyRefusal(board(strokes))).toBeNull()
  })

  it('refuses one stroke too many', () => {
    const strokes = Array.from({ length: WHITEBOARD_MAX_STROKES + 1 }, () => ({ p: [] }))
    expect(whiteboardBodyRefusal(board(strokes))).toBe('strokes')
  })

  it('refuses one point too many', () => {
    const p = Array.from({ length: (WHITEBOARD_MAX_POINTS + 1) * 3 }, () => 0)
    expect(whiteboardBodyRefusal(board([{ c: '#000', z: 1, p }]))).toBe('points')
  })

  it('accepts a body exactly at the byte cap and refuses one byte more', () => {
    const base = JSON.stringify({ v: 1, w: 800, h: 450, s: [], pad: '' })
    const atCap = JSON.stringify({
      v: 1,
      w: 800,
      h: 450,
      s: [],
      pad: 'x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES - utf8ByteLength(base))
    })
    expect(whiteboardBodyBytes(atCap)).toBe(WHITEBOARD_MAX_BLOCK_BYTES)
    expect(whiteboardBodyRefusal(atCap)).toBeNull()
    expect(whiteboardBodyRefusal(atCap.replace('"pad":"', '"pad":"x'))).toBe('blockBytes')
  })

  it('refuses an unparseable body', () => {
    expect(whiteboardBodyRefusal('{')).toBe('invalid')
  })
})
