import { describe, expect, it } from 'vitest'

import { explainEmptySource, explainSourceFailure, figureStyles } from './figure.js'

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

  it('takes the whole clause following "This", not a bare verb', () => {
    // -> The parameter is named `clause` for this reason: it is dropped in unaltered, so a caller
    //    passing `'typeset'` would produce "This typeset: ...".
    expect(explainSourceFailure('drawing could not be read', new Error('x'), true)).toBe(
      'This drawing could not be read: x'
    )
  })
})

describe('shared/figure.js: explainEmptySource()', () => {
  it('names the subject and points at a fenced code block', () => {
    expect(explainEmptySource('diagram')).toBe(
      'This diagram is empty. Its source goes in the body of the block, inside a fenced code block.'
    )
  })

  it('names the fence language when the block has one of its own', () => {
    expect(explainEmptySource('diagram', { fence: 'kroki' })).toBe(
      'This diagram is empty. Its source goes in the body of the block, inside a ```kroki fence.'
    )
  })

  it('names the source the way the block calls it', () => {
    expect(explainEmptySource('formula', { source: 'TeX source' })).toBe(
      'This formula is empty. Its TeX source goes in the body of the block, inside a fenced code block.'
    )
  })
})

describe('shared/figure.js: figureStyles', () => {
  it('lays the figure out in a column, with the drawing scrolling rather than shrinking', () => {
    expect(figureStyles.cssText).toContain('.formula')
    expect(figureStyles.cssText).toContain('.formula.is-left')
    expect(figureStyles.cssText).toContain('overflow-x: auto')
  })

  it('centres the caption, which the shared caption colour deliberately leaves alone', () => {
    expect(figureStyles.cssText).toContain('text-align: center')
  })

  it('carries the gap below the block for both the figure and the error box', () => {
    expect(figureStyles.cssText).toContain('margin-bottom: 16px')
  })
})
