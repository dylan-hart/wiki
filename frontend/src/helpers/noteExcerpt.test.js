import { describe, expect, it } from 'vitest'

import { NOTE_EXCERPT_MAX, noteExcerpt } from './noteExcerpt'

describe('noteExcerpt', () => {
  it('takes the first non-empty line with markdown stripped', () => {
    expect(noteExcerpt('\n\n# Groceries for **Friday**\n\nmilk')).toBe('Groceries for Friday')
    expect(noteExcerpt('- [ ] call the plumber')).toBe('call the plumber')
    expect(noteExcerpt('> quoted _idea_')).toBe('quoted idea')
    expect(noteExcerpt('1. first step')).toBe('first step')
    expect(noteExcerpt('See [the docs](/docs) now')).toBe('See the docs now')
  })

  it('skips fences, rules and block markers', () => {
    expect(noteExcerpt('```js\nconst a = 1\n```\nafter the code')).toBe('after the code')
    expect(noteExcerpt('---\nafter the rule')).toBe('after the rule')
    expect(
      noteExcerpt(
        '::block-whiteboard\n```whiteboard\n{"v":2}\n{"c":"#000000","z":6,"p":[1,1,50]}\n```\n::\nbelow'
      )
    ).toBe('below')
  })

  it('is empty for an empty note', () => {
    expect(noteExcerpt('')).toBe('')
    expect(noteExcerpt(null)).toBe('')
    expect(noteExcerpt('\n   \n')).toBe('')
  })

  it('caps the length', () => {
    expect(noteExcerpt('x'.repeat(500))).toHaveLength(NOTE_EXCERPT_MAX)
  })
})
