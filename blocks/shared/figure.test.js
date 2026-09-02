import { describe, expect, it } from 'vitest'

import { explainSourceFailure } from './figure.js'

const FENCE_HINT =
  '\n\nThe source has to go inside a fenced code block, or markdown rewrites it before this block sees it.'

describe('shared/figure.js: explainSourceFailure()', () => {
  it("names what failed and repeats the library's own message", () => {
    const message = explainSourceFailure(
      'formula could not be typeset',
      new Error('Undefined control sequence: \\frac2'),
      true
    )

    expect(message).toBe('This formula could not be typeset: Undefined control sequence: \\frac2')
  })

  it('adds the fence hint when the source did not come out of a fence', () => {
    const message = explainSourceFailure(
      'diagram could not be drawn',
      new Error('bad shape'),
      false
    )

    expect(message).toBe(`This diagram could not be drawn: bad shape${FENCE_HINT}`)
  })

  it('leaves the hint off when the source did come out of a fence', () => {
    const message = explainSourceFailure('diagram could not be drawn', new Error('bad shape'), true)

    expect(message).not.toContain('fenced code block')
  })

  it('falls back to the thrown value itself when it carries no message', () => {
    expect(explainSourceFailure('formula could not be typeset', 'parse error', true)).toBe(
      'This formula could not be typeset: parse error'
    )
  })
})
