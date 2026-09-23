import { describe, expect, it } from 'vitest'

import {
  isHomePath,
  localeUrlSegment,
  localizedPagePath,
  matchLocaleCode,
  pagePathHash,
  parseLocalePrefix,
  resolveCreatePath,
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

describe('parseLocalePrefix with aliases', () => {
  const codes = ['en', 'zh-CN']
  const aliases = { 'zh-CN': 'zh' }

  it('resolves an alias segment to the canonical code', () => {
    expect(parseLocalePrefix('/zh/some/page', codes, aliases)).toEqual({
      locale: 'zh-CN',
      path: '/some/page'
    })
  })

  it('resolves a bare alias-only path', () => {
    expect(parseLocalePrefix('/zh', codes, aliases)).toEqual({ locale: 'zh-CN', path: '/' })
  })

  it('matches the alias case-insensitively', () => {
    expect(parseLocalePrefix('/ZH/page', codes, aliases)).toEqual({
      locale: 'zh-CN',
      path: '/page'
    })
  })

  it('still recognizes the canonical code', () => {
    expect(parseLocalePrefix('/zh-cn/page', codes, aliases)).toEqual({
      locale: 'zh-CN',
      path: '/page'
    })
  })

  it('ignores an alias whose locale is not active', () => {
    expect(parseLocalePrefix('/zh/page', ['en'], aliases)).toBeNull()
  })

  it('matches an alias key whose casing differs from the stored code', () => {
    expect(parseLocalePrefix('/zh/page', codes, { 'zh-cn': 'zh' })).toEqual({
      locale: 'zh-CN',
      path: '/page'
    })
  })

  it('is unchanged when aliases are omitted, null or empty', () => {
    expect(parseLocalePrefix('/zh/page', codes)).toBeNull()
    expect(parseLocalePrefix('/zh/page', codes, null)).toBeNull()
    expect(parseLocalePrefix('/zh/page', codes, {})).toBeNull()
    expect(parseLocalePrefix('/zh-CN/page', codes, {})).toEqual({
      locale: 'zh-CN',
      path: '/page'
    })
  })
})

describe('localeUrlSegment', () => {
  it('returns the alias when the locale has one', () => {
    expect(localeUrlSegment('zh-CN', { 'zh-CN': 'zh' })).toBe('zh')
  })

  it('returns the code when there is no alias for it', () => {
    expect(localeUrlSegment('fr', { 'zh-CN': 'zh' })).toBe('fr')
    expect(localeUrlSegment('fr')).toBe('fr')
    expect(localeUrlSegment('fr', null)).toBe('fr')
  })

  it('ignores an empty alias', () => {
    expect(localeUrlSegment('zh-CN', { 'zh-CN': '' })).toBe('zh-CN')
  })
})

describe('localizedPagePath with aliases', () => {
  const siteLocales = {
    useLocales: true,
    primary: 'en',
    forcePrefix: false,
    aliases: { 'zh-CN': 'zh', en: 'e' }
  }

  it('emits the alias as the prefix of a non-primary locale', () => {
    expect(localizedPagePath('some/page', 'zh-CN', siteLocales)).toBe('/zh/some/page')
  })

  it('leaves the primary locale unprefixed even if it has an alias', () => {
    expect(localizedPagePath('some/page', 'en', siteLocales)).toBe('/some/page')
  })

  it('emits the primary locale alias under forcePrefix', () => {
    expect(localizedPagePath('some/page', 'en', { ...siteLocales, forcePrefix: true })).toBe(
      '/e/some/page'
    )
  })

  it('emits the canonical code under forcePrefix when the primary has no alias', () => {
    expect(
      localizedPagePath('some/page', 'en', {
        ...siteLocales,
        aliases: { 'zh-CN': 'zh' },
        forcePrefix: true
      })
    ).toBe('/en/some/page')
  })

  it('handles the root path with an alias', () => {
    expect(localizedPagePath('', 'zh-CN', siteLocales)).toBe('/zh/')
  })

  it('never prefixes when the site has only one active locale', () => {
    expect(localizedPagePath('some/page', 'zh-CN', { ...siteLocales, useLocales: false })).toBe(
      '/some/page'
    )
  })

  it('is unchanged when the site has no aliases', () => {
    expect(localizedPagePath('some/page', 'zh-CN', { useLocales: true, primary: 'en' })).toBe(
      '/zh-CN/some/page'
    )
  })

  it('round-trips through parseLocalePrefix', () => {
    const href = localizedPagePath('some/page', 'zh-CN', siteLocales)
    expect(parseLocalePrefix(href, ['en', 'zh-CN'], siteLocales.aliases)).toEqual({
      locale: 'zh-CN',
      path: '/some/page'
    })
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

describe('resolveRouteLocale with aliases', () => {
  const codes = ['en', 'zh-CN']
  const aliases = { 'zh-CN': 'zh' }

  it('reads the canonical locale off an alias prefix', () => {
    expect(resolveRouteLocale('/zh/some/page', {}, codes, 'en', aliases)).toBe('zh-CN')
  })

  it('falls back to primary without a prefix', () => {
    expect(resolveRouteLocale('/some/page', {}, codes, 'en', aliases)).toBe('en')
  })

  it('does not read an alias on an unaliased call', () => {
    expect(resolveRouteLocale('/zh/some/page', {}, codes, 'en')).toBe('en')
  })

  it('reads the locale off the query on an app route by canonical code', () => {
    expect(resolveRouteLocale('/_create/markdown', { locale: 'zh-CN' }, codes, 'en', aliases)).toBe(
      'zh-CN'
    )
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
    // -> Fixed values taken from `backend/helpers/common.ts`'s `generatePathHash`
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

describe('resolveCreatePath', () => {
  it('keeps an explicit path, minus its leading slash', () => {
    expect(resolveCreatePath({ path: '/guides/setup', currentPath: 'a/b' })).toBe('guides/setup')
  })

  it('keeps an explicitly empty path', () => {
    expect(resolveCreatePath({ path: '', currentPath: 'a/b' })).toBe('')
  })

  it('defaults to new-page beside the current page', () => {
    expect(resolveCreatePath({ currentPath: 'guides/intro' })).toBe('guides/new-page')
  })

  it('defaults to a root new-page from a top-level page', () => {
    expect(resolveCreatePath({ currentPath: 'home' })).toBe('new-page')
    expect(resolveCreatePath()).toBe('new-page')
  })

  it('places the default under basePath, trimming its slashes', () => {
    expect(resolveCreatePath({ basePath: '/docs/', currentPath: 'a/b' })).toBe('docs/new-page')
  })

  it('treats an empty basePath as the root', () => {
    expect(resolveCreatePath({ basePath: '', currentPath: 'a/b' })).toBe('new-page')
  })
})
