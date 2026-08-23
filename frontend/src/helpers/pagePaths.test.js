import { describe, expect, it } from 'vitest'

import {
  isHomePath,
  localizedPagePath,
  matchLocaleCode,
  pagePathHash,
  parseLocalePrefix,
  resolveRouteLocale,
  shouldPrefixLocale
} from './pagePaths.js'

describe('isHomePath', () => {
  it('treats the empty path as the home page', () => {
    expect(isHomePath('')).toBe(true)
  })

  it('treats the literal `home` path as the home page', () => {
    expect(isHomePath('home')).toBe(true)
  })

  it('does not treat an ordinary page path as the home page', () => {
    expect(isHomePath('some/page')).toBe(false)
  })

  it('does not treat a path merely containing `home` as the home page', () => {
    expect(isHomePath('home/nested')).toBe(false)
  })
})

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

describe('matchLocaleCode', () => {
  const codes = ['en', 'fr']

  it('matches case-insensitively but returns the code as stored', () => {
    expect(matchLocaleCode('FR', codes)).toBe('fr')
  })

  it('returns null for a code that is not active', () => {
    expect(matchLocaleCode('de', codes)).toBeNull()
  })

  it('returns null for an empty or missing candidate', () => {
    expect(matchLocaleCode('', codes)).toBeNull()
    expect(matchLocaleCode(undefined, codes)).toBeNull()
  })

  it('returns null with no active codes', () => {
    expect(matchLocaleCode('fr', [])).toBeNull()
  })
})

describe('resolveRouteLocale', () => {
  const codes = ['en', 'fr']

  it('reads the locale off an ordinary path prefix', () => {
    expect(resolveRouteLocale('/fr/some/page', {}, codes, 'en')).toBe('fr')
  })

  it('falls back to primary for an ordinary path with no prefix', () => {
    expect(resolveRouteLocale('/some/page', {}, codes, 'en')).toBe('en')
  })

  it('reads the locale off the query on an app route', () => {
    expect(resolveRouteLocale('/_create/markdown', { locale: 'fr' }, codes, 'en')).toBe('fr')
  })

  it('falls back to primary on an app route with no locale query', () => {
    expect(resolveRouteLocale('/_create/markdown', {}, codes, 'en')).toBe('en')
  })

  it('falls back to primary on an app route with an unrecognized locale query', () => {
    expect(resolveRouteLocale('/_create/markdown', { locale: 'de' }, codes, 'en')).toBe('en')
  })

  it('ignores a locale query on an ordinary path', () => {
    expect(resolveRouteLocale('/some/page', { locale: 'fr' }, codes, 'en')).toBe('en')
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

describe('pagePathHash', () => {
  it('matches known output from the backend implementation it mirrors', () => {
    // -> Fixed values from `backend/helpers/common.ts`'s `generatePathHash` — a regression guard
    //    against the two drifting apart, not just an internal self-consistency check.
    expect(pagePathHash('docs/getting-started')).toBe('19df0d1c3f8026')
    expect(pagePathHash('home')).toBe('1867eaf483ceab')
  })

  it('is deterministic for the same input', () => {
    expect(pagePathHash('some/page')).toBe(pagePathHash('some/page'))
  })

  it('differs for different paths', () => {
    expect(pagePathHash('some/page')).not.toBe(pagePathHash('some/other-page'))
  })
})
