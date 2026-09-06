import { describe, expect, it } from 'vitest'

import { initials } from './initials'

describe('initials', () => {
  it('takes the first letter of each of a two-word name', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
  })

  it('gives a mononym its single letter rather than doubling it', () => {
    expect(initials('Prince')).toBe('P')
    expect(initials('X')).toBe('X')
  })

  it('takes the FIRST and LAST word of a three-or-more-word name, not the first two', () => {
    // -> The whole point of the consolidation: `PageComments` used to answer `DJ` here
    expect(initials('Dylan James Hart')).toBe('DH')
    expect(initials('Ada Augusta King Lovelace')).toBe('AL')
  })

  it('falls back to a neutral glyph for a name with no letters to take', () => {
    expect(initials('')).toBe('?')
    expect(initials('   ')).toBe('?')
    expect(initials('\t\n ')).toBe('?')
  })

  it('treats a missing name as an empty one rather than throwing', () => {
    expect(initials(null)).toBe('?')
    expect(initials(undefined)).toBe('?')
  })

  it('ignores leading, trailing and repeated internal whitespace', () => {
    expect(initials('  Ada Lovelace  ')).toBe('AL')
    expect(initials('Ada   Lovelace')).toBe('AL')
    expect(initials('\tGrace\nHopper ')).toBe('GH')
  })

  it('uppercases a lowercase name', () => {
    expect(initials('grace hopper')).toBe('GH')
  })
})
