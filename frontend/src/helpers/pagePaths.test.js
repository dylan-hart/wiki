import { describe, expect, it } from 'vitest'

import { localizedPagePath, parseLocalePrefix, shouldPrefixLocale } from './pagePaths.js'

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

describe('localizedPagePath', () => {
  const siteLocales = { useLocales: true, primary: 'en', forcePrefix: false }

  it('leaves the primary locale unprefixed', () => {
    expect(localizedPagePath('some/page', 'en', siteLocales)).toBe('/some/page')
  })

  it('prefixes a non-primary locale', () => {
    expect(localizedPagePath('some/page', 'fr', siteLocales)).toBe('/fr/some/page')
  })

  it('never prefixes when the site has only one active locale', () => {
    expect(localizedPagePath('some/page', 'fr', { useLocales: false, primary: 'en' })).toBe(
      '/some/page'
    )
  })

  it('prefixes the primary locale too when forcePrefix is on', () => {
    expect(
      localizedPagePath('some/page', 'en', { useLocales: true, primary: 'en', forcePrefix: true })
    ).toBe('/en/some/page')
  })

  it('handles the root path', () => {
    expect(localizedPagePath('', 'fr', siteLocales)).toBe('/fr/')
  })
})

describe('shouldPrefixLocale', () => {
  it('is false for a single-locale site regardless of forcePrefix', () => {
    expect(shouldPrefixLocale('en', { useLocales: false, primary: 'en', forcePrefix: true })).toBe(
      false
    )
  })

  it('is false for the primary locale with forcePrefix off', () => {
    expect(shouldPrefixLocale('en', { useLocales: true, primary: 'en', forcePrefix: false })).toBe(
      false
    )
  })

  it('is true for the primary locale with forcePrefix on', () => {
    expect(shouldPrefixLocale('en', { useLocales: true, primary: 'en', forcePrefix: true })).toBe(
      true
    )
  })

  it('is true for a non-primary locale regardless of forcePrefix', () => {
    expect(shouldPrefixLocale('fr', { useLocales: true, primary: 'en', forcePrefix: false })).toBe(
      true
    )
  })
})
