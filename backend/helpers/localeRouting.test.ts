import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CustomError } from './common.ts'
import {
  assertLocaleActive,
  assertPathNotReservedLocale,
  defaultLocale,
  localePrefixRedirectTarget,
  localePrefixStripTarget,
  localizedPagePath,
  matchLocaleCode,
  shouldPrefixLocale,
  stripLocalePrefix,
  type LocaleRoutingConfig
} from './localeRouting.ts'

let wikiHandle: { restore(): void }
import { installTestWiki } from '../test/mocks.ts'

const locales = (overrides: Partial<LocaleRoutingConfig> = {}): LocaleRoutingConfig => ({
  primary: 'en',
  active: ['en', 'fr'],
  forcePrefix: true,
  ...overrides
})

describe('stripLocalePrefix', () => {
  test('recognizes an active locale as the leading segment', () => {
    assert.deepEqual(stripLocalePrefix('/fr/some/page', locales()), {
      locale: 'fr',
      path: '/some/page'
    })
  })

  test('recognizes a bare locale-only path', () => {
    assert.deepEqual(stripLocalePrefix('/fr', locales()), { locale: 'fr', path: '/' })
  })

  test('matches case-insensitively but returns the code as stored', () => {
    assert.deepEqual(stripLocalePrefix('/FR/page', locales()), { locale: 'fr', path: '/page' })
  })

  test('does not match a leading segment that is not an active code', () => {
    assert.equal(stripLocalePrefix('/de/page', locales()), null)
  })

  test('does not match the root path', () => {
    assert.equal(stripLocalePrefix('/', locales()), null)
  })

  test('returns null with no locales config', () => {
    assert.equal(stripLocalePrefix('/fr/page', null), null)
  })

  test('returns null with an empty active list', () => {
    assert.equal(stripLocalePrefix('/fr/page', locales({ active: [] })), null)
  })
})

/**
 * The single case-insensitive matcher `stripLocalePrefix` above and `helpers/appShell.ts`'s
 * `resolveAppShellLocale` both delegate to now (OpenProject #1024's consolidation), rather than each
 * keeping its own inlined `.find((code) => code.toLowerCase() === ...)`.
 */
describe('matchLocaleCode', () => {
  test('returns the canonically-cased match for a differently-cased candidate', () => {
    assert.equal(matchLocaleCode('FR', ['en', 'fr']), 'fr')
  })

  test('returns the exact match unchanged', () => {
    assert.equal(matchLocaleCode('fr', ['en', 'fr']), 'fr')
  })

  test('returns null when nothing matches', () => {
    assert.equal(matchLocaleCode('de', ['en', 'fr']), null)
  })

  test('returns null with no active list', () => {
    assert.equal(matchLocaleCode('fr', null), null)
    assert.equal(matchLocaleCode('fr', undefined), null)
  })

  test('returns null with an empty active list', () => {
    assert.equal(matchLocaleCode('fr', []), null)
  })
})

/**
 * The single source `api/tree.ts`, `api/pages/read.ts` and `models/pages.ts` all delegate to now
 * (OpenProject #1024's consolidation), rather than each keeping its own copy of the same
 * `WIKI.sites[siteId]?.config?.locales?.primary ?? 'en'` fallback.
 */
describe('defaultLocale', () => {
  let wikiHandle: { restore(): void }

  test("returns the site's configured primary locale", () => {
    wikiHandle = installTestWiki({
      sites: { 'site-1': { config: { locales: { primary: 'fr' } } } }
    })
    try {
      assert.equal(defaultLocale('site-1'), 'fr')
    } finally {
      wikiHandle.restore()
    }
  })

  test("falls back to 'en' for an unknown site", () => {
    wikiHandle = installTestWiki({ sites: {} })
    try {
      assert.equal(defaultLocale('no-such-site'), 'en')
    } finally {
      wikiHandle.restore()
    }
  })

  test("falls back to 'en' when the site has no locales configured", () => {
    wikiHandle = installTestWiki({ sites: { 'site-1': { config: {} } } })
    try {
      assert.equal(defaultLocale('site-1'), 'en')
    } finally {
      wikiHandle.restore()
    }
  })
})

/**
 * The refusal `models/pages.ts` makes on both the way in (`createPage`) and the way across
 * (`movePage`), written once here rather than as two copies of the same `active ?? [primary]` read.
 */
describe('assertLocaleActive', () => {
  function withSites<T>(sites: any, fn: () => T): T {
    wikiHandle = installTestWiki({ sites })
    try {
      return fn()
    } finally {
      wikiHandle.restore()
    }
  }

  test('accepts a locale the site has enabled', () => {
    withSites(
      { 'site-1': { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } },
      () => {
        assert.doesNotThrow(() => assertLocaleActive('site-1', 'fr'))
      }
    )
  })

  test('refuses a locale the site has turned off, as pageInvalidLocale 400', () => {
    withSites({ 'site-1': { config: { locales: { primary: 'en', active: ['en'] } } } }, () => {
      assert.throws(
        () => assertLocaleActive('site-1', 'de'),
        (err: CustomError) => {
          assert.equal(err.name, 'pageInvalidLocale')
          assert.equal(err.message, 'This site does not have the "de" locale enabled.')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })
  })

  test('falls back to the primary locale alone when the site lists no active locales', () => {
    withSites({ 'site-1': { config: { locales: { primary: 'fr' } } } }, () => {
      assert.doesNotThrow(() => assertLocaleActive('site-1', 'fr'))
      assert.throws(() => assertLocaleActive('site-1', 'en'), { name: 'pageInvalidLocale' })
    })
  })
})

/**
 * A page path whose first segment is an installed locale code would be swallowed by the URL parser's
 * locale-prefix strip, so `createPage`/`movePage` refuse it outright.
 */
describe('assertPathNotReservedLocale', () => {
  function withReservedCodes<T>(reserved: string[], fn: () => Promise<T>): Promise<T> {
    wikiHandle = installTestWiki({
      models: {
        locales: { isReservedLocaleCode: async (code: string) => reserved.includes(code) }
      }
    })
    return fn().finally(() => {
      wikiHandle.restore()
    })
  }

  test('accepts a path whose first segment is not an installed locale code', async () => {
    await withReservedCodes(['fr'], async () => {
      await assertPathNotReservedLocale('guide/getting-started')
    })
  })

  test('refuses a path beginning with an installed locale code, as pageReservedLocaleSegment 400', async () => {
    await withReservedCodes(['fr'], async () => {
      await assert.rejects(assertPathNotReservedLocale('fr/guide'), (err: CustomError) => {
        assert.equal(err.name, 'pageReservedLocaleSegment')
        assert.equal(err.message, '"fr" is an installed locale code and cannot begin a page path.')
        assert.equal(err.statusCode, 400)
        return true
      })
    })
  })

  test('checks only the first segment', async () => {
    await withReservedCodes(['fr'], async () => {
      await assertPathNotReservedLocale('guide/fr')
    })
  })

  test('treats a single-segment path as its own first segment', async () => {
    await withReservedCodes(['fr'], async () => {
      await assert.rejects(assertPathNotReservedLocale('fr'), { name: 'pageReservedLocaleSegment' })
    })
  })
})

describe('localePrefixRedirectTarget', () => {
  test('single active locale never redirects, even with forcePrefix on', () => {
    assert.equal(
      localePrefixRedirectTarget('/foo/bar', locales({ active: ['en'], forcePrefix: true })),
      null
    )
  })

  test('multiple actives with forcePrefix off never redirects', () => {
    assert.equal(
      localePrefixRedirectTarget('/foo/bar', locales({ active: ['en', 'fr'], forcePrefix: false })),
      null
    )
  })

  test('forcePrefix on with a bare path redirects to the primary locale', () => {
    assert.equal(
      localePrefixRedirectTarget('/foo/bar', locales({ forcePrefix: true })),
      '/en/foo/bar'
    )
  })

  test('forcePrefix on with the root path redirects to the bare primary segment', () => {
    assert.equal(localePrefixRedirectTarget('/', locales({ forcePrefix: true })), '/en')
  })

  test('forcePrefix on with an already-prefixed non-primary active locale does not redirect', () => {
    assert.equal(localePrefixRedirectTarget('/fr/foo/bar', locales({ forcePrefix: true })), null)
  })

  test("an unrecognized first segment that looks like a locale code but isn't active redirects", () => {
    // "de" reads like a locale code, but this site only has en/fr active, so it is just an ordinary
    // page path that happens to start with something locale-shaped.
    assert.equal(
      localePrefixRedirectTarget('/de/foo', locales({ forcePrefix: true })),
      '/en/de/foo'
    )
  })
})

describe('shouldPrefixLocale', () => {
  test('the primary locale is bare unless forcePrefix', () => {
    assert.equal(shouldPrefixLocale('en', locales({ forcePrefix: false })), false)
    assert.equal(shouldPrefixLocale('en', locales({ forcePrefix: true })), true)
  })
  test('a non-primary active locale is always prefixed', () => {
    assert.equal(shouldPrefixLocale('fr', locales({ forcePrefix: false })), true)
  })
  test('a single active locale never prefixes', () => {
    assert.equal(shouldPrefixLocale('en', locales({ active: ['en'], forcePrefix: true })), false)
  })
})

describe('localizedPagePath', () => {
  test('prefixes exactly when shouldPrefixLocale says to', () => {
    assert.equal(
      localizedPagePath('guides/x', 'fr', locales({ forcePrefix: false })),
      '/fr/guides/x'
    )
    assert.equal(localizedPagePath('guides/x', 'en', locales({ forcePrefix: false })), '/guides/x')
    assert.equal(
      localizedPagePath('guides/x', 'en', locales({ forcePrefix: true })),
      '/en/guides/x'
    )
  })
})

describe('localePrefixStripTarget', () => {
  test('an explicit primary prefix is stripped', () => {
    assert.equal(
      localePrefixStripTarget('/en/guides/x', locales({ forcePrefix: false })),
      '/guides/x'
    )
  })
  test('a bare locale-only primary path strips to the root', () => {
    assert.equal(localePrefixStripTarget('/en', locales({ forcePrefix: false })), '/')
  })
  test('a non-primary prefix is kept', () => {
    assert.equal(localePrefixStripTarget('/fr/guides/x', locales({ forcePrefix: false })), null)
  })
  test('under forcePrefix nothing is stripped', () => {
    assert.equal(localePrefixStripTarget('/en/guides/x', locales({ forcePrefix: true })), null)
  })
  test('a mis-cased prefix canonicalizes to the code as stored', () => {
    assert.equal(
      localePrefixStripTarget('/FR/guides/x', locales({ forcePrefix: false })),
      '/fr/guides/x'
    )
  })
  test('a single-active-locale site strips its own explicit prefix', () => {
    assert.equal(
      localePrefixStripTarget('/en/guides/x', locales({ active: ['en'], forcePrefix: false })),
      '/guides/x'
    )
  })
  test('an unprefixed path is not a candidate', () => {
    assert.equal(localePrefixStripTarget('/guides/x', locales({ forcePrefix: false })), null)
  })
})
