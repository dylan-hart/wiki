import { describe, expect, it } from 'vitest'

import { parseLocalePrefix } from './pagePaths.js'

describe('parseLocalePrefix', () => {
  const codes = ['en', 'fr']

  it('recognizes an active locale as the leading segment', () => {
    expect(parseLocalePrefix('/fr/some/page', codes)).toEqual({ locale: 'fr', path: '/some/page' })
  })

  it('recognizes a bare locale-only path', () => {
    expect(parseLocalePrefix('/fr', codes)).toEqual({ locale: 'fr', path: '/' })
  })

  it('matches case-insensitively but returns the code as stored', () => {
    expect(parseLocalePrefix('/FR/page', codes)).toEqual({ locale: 'fr', path: '/page' })
  })

  it('does not match a leading segment that is not an active code', () => {
    expect(parseLocalePrefix('/de/page', codes)).toBeNull()
  })

  it('does not match the root path', () => {
    expect(parseLocalePrefix('/', codes)).toBeNull()
  })

  it('returns null with no active codes', () => {
    expect(parseLocalePrefix('/fr/page', null)).toBeNull()
  })

  it('returns null with an empty active list', () => {
    expect(parseLocalePrefix('/fr/page', [])).toBeNull()
  })
})
