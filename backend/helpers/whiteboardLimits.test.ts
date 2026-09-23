import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WHITEBOARD_MAX_BLOCK_BYTES,
  WHITEBOARD_MAX_PAGE_BYTES,
  WHITEBOARD_MAX_POINTS,
  WHITEBOARD_MAX_STROKES,
  countWhiteboardStrokes,
  describeWhiteboardCapViolation,
  findWhiteboardCapViolation,
  whiteboardBodyBytes
} from './whiteboardLimits.ts'

function board(strokes: number[][]): string {
  return JSON.stringify({
    v: 1,
    w: 800,
    h: 450,
    s: strokes.map((p) => ({ c: '#1f2937', z: 4, p }))
  })
}

function triples(count: number): number[] {
  return Array.from({ length: count * 3 }, () => 0)
}

describe('whiteboardLimits: the pinned cap', () => {
  test('matches the literal numbers every workspace copy shares', () => {
    assert.equal(WHITEBOARD_MAX_BLOCK_BYTES, 262144)
    assert.equal(WHITEBOARD_MAX_STROKES, 2000)
    assert.equal(WHITEBOARD_MAX_POINTS, 50000)
    assert.equal(WHITEBOARD_MAX_PAGE_BYTES, 1048576)
  })
})

describe('whiteboardLimits: whiteboardBodyBytes', () => {
  test('counts UTF-8 bytes of the trimmed body, not characters', () => {
    assert.equal(whiteboardBodyBytes('  abc\n'), 3)
    assert.equal(whiteboardBodyBytes('é'), 2)
    assert.equal(whiteboardBodyBytes(''), 0)
  })
})

describe('whiteboardLimits: countWhiteboardStrokes', () => {
  test('counts strokes and floor(p.length / 3) points per stroke', () => {
    assert.deepEqual(
      countWhiteboardStrokes(
        board([
          [1, 2, 3, 4, 5, 6],
          [1, 2, 3, 4]
        ])
      ),
      {
        strokes: 2,
        points: 3
      }
    )
  })

  test('an empty board is zero strokes', () => {
    assert.deepEqual(countWhiteboardStrokes(board([])), { strokes: 0, points: 0 })
  })

  test('malformed or off-format JSON counts as nothing rather than throwing', () => {
    assert.deepEqual(countWhiteboardStrokes('{not json'), { strokes: 0, points: 0 })
    assert.deepEqual(countWhiteboardStrokes('null'), { strokes: 0, points: 0 })
    assert.deepEqual(countWhiteboardStrokes('{"s":"x"}'), { strokes: 0, points: 0 })
    assert.deepEqual(countWhiteboardStrokes('{"s":[null,{"p":"x"},{"p":[1,2,3]}]}'), {
      strokes: 3,
      points: 1
    })
  })
})

describe('whiteboardLimits: findWhiteboardCapViolation', () => {
  test('passes no bodies, an empty board and one exactly at each limit', () => {
    assert.equal(findWhiteboardCapViolation([]), null)
    assert.equal(findWhiteboardCapViolation([board([])]), null)
    assert.equal(findWhiteboardCapViolation(['x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES)]), null)
    assert.equal(
      findWhiteboardCapViolation([board(Array.from({ length: 2000 }, () => [1, 2, 3]))]),
      null
    )
  })

  test('exactly 50,000 points is not a points refusal', () => {
    assert.notEqual(
      findWhiteboardCapViolation([board([triples(40000), triples(10000)])])?.kind,
      'points'
    )
  })

  test('refuses one block over the byte cap', () => {
    assert.deepEqual(findWhiteboardCapViolation(['x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES + 1)]), {
      kind: 'blockBytes',
      actual: 262145,
      limit: 262144
    })
  })

  test('measures bytes, so multi-byte text under the character count is still refused', () => {
    const body = 'é'.repeat(WHITEBOARD_MAX_BLOCK_BYTES / 2 + 1)
    assert.equal(findWhiteboardCapViolation([body])?.kind, 'blockBytes')
  })

  test('refuses a block with too many strokes', () => {
    const violation = findWhiteboardCapViolation([
      board(Array.from({ length: 2001 }, () => [1, 2, 3]))
    ])
    assert.deepEqual(violation, { kind: 'strokes', actual: 2001, limit: 2000 })
  })

  test('refuses a block with too many points across its strokes', () => {
    const violation = findWhiteboardCapViolation([board([triples(40000), triples(10001)])])
    assert.deepEqual(violation, { kind: 'points', actual: 50001, limit: 50000 })
  })

  test('refuses a page whose blocks are each under the cap but together over it', () => {
    const block = 'x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES)
    assert.equal(findWhiteboardCapViolation([block, block, block, block]), null)
    assert.deepEqual(findWhiteboardCapViolation([block, block, block, block, 'y']), {
      kind: 'pageBytes',
      actual: 1048577,
      limit: 1048576
    })
  })

  test('describes every kind of refusal with its numbers', () => {
    for (const kind of ['blockBytes', 'pageBytes', 'strokes', 'points'] as const) {
      const message = describeWhiteboardCapViolation({ kind, actual: 7, limit: 5 })
      assert.match(message, /7/)
      assert.match(message, /5/)
      assert.match(message, /not saved/)
    }
  })
})
