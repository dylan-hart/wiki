import { describe, expect, it } from 'vitest'

import { linesOutsideFences } from './markdownFences'

/** Collects `[line, index]` for every line the walk actually visits. */
function visited(source, visit) {
  const seen = []
  linesOutsideFences(source.split('\n'), (line, index) => {
    seen.push([line, index])
    return visit?.(line, index)
  })
  return seen
}

describe('linesOutsideFences', () => {
  it('visits every line of unfenced text', () => {
    expect(visited('a\nb\nc')).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2]
    ])
  })

  it('skips the fence lines and everything between them', () => {
    expect(visited('a\n```\ninside\n```\nb').map(([line]) => line)).toEqual(['a', 'b'])
  })

  it('treats a tilde fence the same way as a backtick fence', () => {
    expect(visited('a\n~~~\ninside\n~~~\nb').map(([line]) => line)).toEqual(['a', 'b'])
  })

  it('does not close a backtick fence on a tilde line', () => {
    expect(visited('```\n~~~\nstill inside').map(([line]) => line)).toEqual([])
  })

  it('needs a closing fence at least as long as the one that opened it', () => {
    expect(visited('````\n```\nstill inside\n````\nout').map(([line]) => line)).toEqual(['out'])
  })

  it('allows the three spaces of indentation markdown allows on a fence', () => {
    expect(visited('   ```\ninside\n   ```\nout').map(([line]) => line)).toEqual(['out'])
  })

  it('leaves a four-space-indented fence as ordinary content', () => {
    expect(visited('    ```\nb').map(([line]) => line)).toEqual(['    ```', 'b'])
  })

  it('leaves an unclosed fence swallowing the rest of the document', () => {
    expect(visited('a\n```\nb\nc').map(([line]) => line)).toEqual(['a'])
  })

  it('resumes at the index the visitor returns', () => {
    expect(visited('a\nb\nc\nd', (_line, index) => (index === 0 ? 2 : undefined))).toEqual([
      ['a', 0],
      ['d', 3]
    ])
  })

  it('carries on line by line when the visitor returns nothing', () => {
    expect(visited('a\nb').map(([, index]) => index)).toEqual([0, 1])
  })

  it('does not re-enter a fence the visitor skipped over', () => {
    expect(
      visited('a\nb\n```\nx\n```\nc', (_line, index) => (index === 0 ? 4 : undefined)).map(
        ([line]) => line
      )
    ).toEqual(['a', 'c'])
  })
})
