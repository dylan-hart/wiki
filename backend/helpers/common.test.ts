import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import {
  assertLocaleActive,
  assertPathNotReservedLocale,
  CustomError,
  defaultLocale,
  escapeLikePattern,
  guardSiteEnabled,
  isHashedAssetFilename,
  isSameOriginWebSocketHandshake,
  isUniqueViolation,
  localePrefixRedirectTarget,
  localePrefixStripTarget,
  localizedPagePath,
  maskSensitiveConfig,
  matchLocaleCode,
  normalizeHostname,
  requestOrigin,
  resolveRequestSite,
  SENSITIVE_CONFIG_MASK,
  shouldPrefixLocale,
  siteEnabledPreHandler,
  siteIdForHostname,
  SITE_DISABLED_MESSAGE,
  SITE_MISSING_MESSAGE,
  stripLocalePrefix,
  unmaskSensitiveConfig,
  type LocaleRoutingConfig,
  type ModuleProp
} from './common.ts'

function fakeProp(overrides: Partial<ModuleProp> = {}): ModuleProp {
  return {
    default: '',
    type: 'string',
    title: 'Fake Prop',
    hint: '',
    enum: false,
    enumDisplay: 'select',
    multiline: false,
    sensitive: false,
    readOnly: false,
    required: false,
    pattern: '',
    icon: 'text-box',
    order: 100,
    if: [],
    ...overrides
  }
}

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
 * The single source `api/tree.ts`, `api/pages.ts` and `models/pages.ts` all delegate to now
 * (OpenProject #1024's consolidation), rather than each keeping its own copy of the same
 * `WIKI.sites[siteId]?.config?.locales?.primary ?? 'en'` fallback.
 */
describe('defaultLocale', () => {
  let previousWiki: any

  test("returns the site's configured primary locale", () => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites: { 'site-1': { config: { locales: { primary: 'fr' } } } } }
    try {
      assert.equal(defaultLocale('site-1'), 'fr')
    } finally {
      ;(globalThis as any).WIKI = previousWiki
    }
  })

  test("falls back to 'en' for an unknown site", () => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites: {} }
    try {
      assert.equal(defaultLocale('no-such-site'), 'en')
    } finally {
      ;(globalThis as any).WIKI = previousWiki
    }
  })

  test("falls back to 'en' when the site has no locales configured", () => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites: { 'site-1': { config: {} } } }
    try {
      assert.equal(defaultLocale('site-1'), 'en')
    } finally {
      ;(globalThis as any).WIKI = previousWiki
    }
  })
})

/**
 * The refusal `models/pages.ts` makes on both the way in (`createPage`) and the way across
 * (`movePage`), written once here rather than as two copies of the same `active ?? [primary]` read.
 */
describe('assertLocaleActive', () => {
  function withSites<T>(sites: any, fn: () => T): T {
    const previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites }
    try {
      return fn()
    } finally {
      ;(globalThis as any).WIKI = previousWiki
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
    const previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      models: {
        locales: { isReservedLocaleCode: async (code: string) => reserved.includes(code) }
      }
    }
    return fn().finally(() => {
      ;(globalThis as any).WIKI = previousWiki
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

/**
 * OpenProject #831: the site's canonical/public URL — as consumed by `controllers/seo.ts` and, once
 * one exists, any `codeTemplate` comment provider's embed (see `models/commentProviders.ts`) — must
 * match how the request was actually reached, including behind a reverse proxy and on a non-default
 * port. `requestOrigin` is deliberately a one-line pass-through of `req.protocol`/`req.hostname`
 * rather than anything that re-derives scheme/host itself; these tests pin that contract so it can't
 * quietly grow a second, divergent way to compute the same thing.
 */
describe('requestOrigin', () => {
  test('joins protocol and hostname on the default port, exactly as given', () => {
    assert.equal(requestOrigin('https', 'wiki.example.com'), 'https://wiki.example.com')
  })

  test('preserves a non-default port carried on the hostname', () => {
    // -> This is what `req.hostname` looks like when a browser's address bar itself names a
    //    non-default port, e.g. a dev instance on :3000 with no proxy in front of it at all.
    assert.equal(requestOrigin('http', 'wiki.example.com:3000'), 'http://wiki.example.com:3000')
  })

  test('reflects a reverse-proxy-terminated scheme even when it differs from the raw connection', () => {
    // -> Simulates what Fastify's `trustProxy` hands `req.protocol` when a proxy terminates TLS and
    //    forwards plain HTTP internally: the *public* scheme, not the one this process actually
    //    listens on. Getting this wrong is exactly requarks/wiki #2549's failure mode.
    assert.equal(requestOrigin('https', 'wiki.example.com'), 'https://wiki.example.com')
  })

  test('reflects a reverse-proxy-rewritten hostname, port included', () => {
    // -> `X-Forwarded-Host` under `trustProxy`, e.g. a proxy fronting several internal ports on one
    //    public non-default port. Getting this wrong is requarks/wiki #2784's failure mode: the
    //    embed identifies the page by a URL nobody outside the proxy can actually reach.
    assert.equal(requestOrigin('https', 'wiki.example.com:8443'), 'https://wiki.example.com:8443')
  })

  test('never inserts a port of its own — whatever the hostname carries is what is used', () => {
    assert.equal(requestOrigin('https', 'wiki.example.com'), 'https://wiki.example.com')
    assert.ok(!requestOrigin('https', 'wiki.example.com').includes(':443'))
  })
})

describe('isSameOriginWebSocketHandshake', () => {
  test('accepts a same-origin handshake', () => {
    assert.equal(
      isSameOriginWebSocketHandshake('https://wiki.example.com', 'wiki.example.com'),
      true
    )
  })

  test('accepts a same-origin handshake with a matching non-default port', () => {
    assert.equal(isSameOriginWebSocketHandshake('http://localhost:3001', 'localhost:3001'), true)
  })

  test('rejects a foreign origin', () => {
    assert.equal(
      isSameOriginWebSocketHandshake('https://evil.example.com', 'wiki.example.com'),
      false
    )
  })

  test('rejects a same hostname on a different port', () => {
    // -> The origin's `host` carries the port; a page served on :8080 is not this handshake's origin
    //    just because the hostname matches.
    assert.equal(
      isSameOriginWebSocketHandshake('https://wiki.example.com:8080', 'wiki.example.com'),
      false
    )
  })

  test('rejects a missing Origin header', () => {
    // -> Unlike `resolveOrigin` in `models/passkeys.ts`, a WebSocket handshake has no legitimate
    //    non-browser caller that would omit it — every real one is a browser upgrade request.
    assert.equal(isSameOriginWebSocketHandshake(undefined, 'wiki.example.com'), false)
  })

  test('rejects an Origin header that fails to parse as a URL', () => {
    assert.equal(isSameOriginWebSocketHandshake('not a url', 'wiki.example.com'), false)
  })

  test('rejects a missing Host header even with a well-formed Origin', () => {
    assert.equal(isSameOriginWebSocketHandshake('https://wiki.example.com', undefined), false)
  })

  test("accepts a foreign-looking origin whose hostname is one of this instance's own other sites", () => {
    assert.equal(
      isSameOriginWebSocketHandshake('https://second-site.example.com', 'wiki.example.com', [
        'wiki.example.com',
        'second-site.example.com'
      ]),
      true
    )
  })

  test('still rejects a hostname absent from the site list', () => {
    assert.equal(
      isSameOriginWebSocketHandshake('https://evil.example.com', 'wiki.example.com', [
        'wiki.example.com',
        'second-site.example.com'
      ]),
      false
    )
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

const ENABLED_SITE_ID = 'enabled-site-id'
const DISABLED_SITE_ID = 'disabled-site-id'
const WILDCARD_SITE_ID = 'wildcard-site-id'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
  [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, hostname: 'off.example.com', isEnabled: false },
  [WILDCARD_SITE_ID]: { id: WILDCARD_SITE_ID, hostname: '*', isEnabled: true }
}

const sitesMappings: Record<string, string> = {
  'wiki.example.com': ENABLED_SITE_ID,
  'off.example.com': DISABLED_SITE_ID,
  '*': WILDCARD_SITE_ID
}

const NO_EXEMPT_SEGMENTS = new Set<string>()
const LOGIN_EXEMPT = new Set(['login'])

describe('normalizeHostname', () => {
  test('lowercases every character', () => {
    assert.equal(normalizeHostname('Wiki.Example.Com'), 'wiki.example.com')
  })

  test('leaves an already-lowercase hostname unchanged', () => {
    assert.equal(normalizeHostname('wiki.example.com'), 'wiki.example.com')
  })
})

describe('siteIdForHostname', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites, sitesMappings }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('resolves a hostname the instance answers to', () => {
    assert.equal(siteIdForHostname('wiki.example.com'), ENABLED_SITE_ID)
  })

  test('matches case-insensitively (OpenProject #2127)', () => {
    assert.equal(siteIdForHostname('Wiki.Example.Com'), ENABLED_SITE_ID)
  })

  test('falls back to the wildcard site for an unknown hostname', () => {
    assert.equal(siteIdForHostname('nobody.example.com'), WILDCARD_SITE_ID)
  })

  test('falls back to the wildcard site when there is no hostname at all', () => {
    assert.equal(siteIdForHostname(undefined), WILDCARD_SITE_ID)
    assert.equal(siteIdForHostname(''), WILDCARD_SITE_ID)
  })

  test('strict refuses the wildcard fallback', () => {
    assert.equal(siteIdForHostname('wiki.example.com', { strict: true }), ENABLED_SITE_ID)
    assert.equal(siteIdForHostname('nobody.example.com', { strict: true }), undefined)
    assert.equal(siteIdForHostname(undefined, { strict: true }), undefined)
  })
})

describe('isUniqueViolation', () => {
  test('recognizes a postgres 23505 raised directly', () => {
    assert.equal(isUniqueViolation(Object.assign(new Error('dupe'), { code: '23505' })), true)
  })

  test('recognizes a 23505 wrapped as the cause of a driver error', () => {
    assert.equal(
      isUniqueViolation(
        Object.assign(new Error('dupe'), {
          cause: Object.assign(new Error('dupe'), { code: '23505' })
        })
      ),
      true
    )
  })

  test('refuses another postgres error code', () => {
    assert.equal(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' })), false)
  })

  test('refuses a plain error, null and undefined', () => {
    assert.equal(isUniqueViolation(new Error('boom')), false)
    assert.equal(isUniqueViolation(null), false)
    assert.equal(isUniqueViolation(undefined), false)
  })
})

describe('escapeLikePattern', () => {
  test('escapes the two LIKE wildcards and the escape character itself', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%')
    assert.equal(escapeLikePattern('a_b'), 'a\\_b')
    assert.equal(escapeLikePattern('back\\slash'), 'back\\\\slash')
  })

  test('leaves an ordinary filter string alone', () => {
    assert.equal(escapeLikePattern('editors'), 'editors')
  })

  test('escapes the backslash before the wildcards, never twice over', () => {
    assert.equal(escapeLikePattern('\\%'), '\\\\\\%')
  })
})

describe('resolveRequestSite', () => {
  test('resolves a mixed-case hostname to the same site as its lowercase form (OpenProject #2140)', () => {
    const lower = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'wiki.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    const mixed = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'Wiki.Example.Com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(mixed, lower)
    assert.deepEqual(mixed, { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
  })

  test('resolves an enabled site to "ok" with the site attached', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'wiki.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
  })

  test('falls back to the wildcard mapping when the hostname has no exact match, same precedence as the SEO hook', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'unmapped.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'ok', site: sites[WILDCARD_SITE_ID] })
  })

  test('reports "not-found" when neither the hostname nor a wildcard mapping exists', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'unmapped.example.com',
      sitesMappings: { 'wiki.example.com': ENABLED_SITE_ID },
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'not-found' })
  })

  test('distinguishes "disabled" from "not-found" for a resolved-but-disabled site', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'off.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
  })

  test('lets an exempt first segment through regardless of the site being disabled', () => {
    const result = resolveRequestSite({
      firstSegment: 'login',
      hostname: 'off.example.com',
      sitesMappings,
      sites,
      exemptSegments: LOGIN_EXEMPT
    })
    assert.deepEqual(result, { outcome: 'exempt' })
  })

  test('lets an exempt first segment through regardless of the hostname matching no site at all', () => {
    const result = resolveRequestSite({
      firstSegment: 'login',
      hostname: 'unmapped.example.com',
      sitesMappings: { 'wiki.example.com': ENABLED_SITE_ID },
      sites,
      exemptSegments: LOGIN_EXEMPT
    })
    assert.deepEqual(result, { outcome: 'exempt' })
  })

  /**
   * OpenProject #2127: `sitesMappings` is keyed lowercase (site hostnames are constrained to
   * lowercase on write), but a request's `Host` header case was never folded before the lookup --
   * a mixed-case `Host` for an otherwise-valid hostname fell through to the wildcard mapping or to
   * "not-found", the same as an unrelated, genuinely unknown hostname.
   */
  test('resolves a mixed-case Host header to the same site as its lowercase form', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'Wiki.Example.Com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
  })
})

describe('normalizeHostname', () => {
  test('lowercases', () => {
    assert.equal(normalizeHostname('Wiki.Example.Com'), 'wiki.example.com')
  })

  test('is a no-op on an already-lowercase hostname', () => {
    assert.equal(normalizeHostname('wiki.example.com'), 'wiki.example.com')
  })

  test('leaves the wildcard mapping key untouched', () => {
    assert.equal(normalizeHostname('*'), '*')
  })
})

/**
 * Task 2085: an unauthenticated client naming another site's hostname in `X-Forwarded-Host` must not
 * be able to steer site resolution, unless it genuinely arrived through a proxy address the instance
 * has been told to trust. `resolveRequestSite` itself trusts whatever `hostname` it is handed (see its
 * doc comment) -- the refusal happens one layer up, in Fastify's own `trustProxy`-aware
 * `request.hostname` getter, exercised here exactly as `index.ts`'s site-resolution hook uses it: a
 * real Fastify instance, a real `trustProxy` address spec, and `.inject()`'s `remoteAddress` standing
 * in for the socket peer.
 */
describe('resolveRequestSite via Fastify: X-Forwarded-Host trust boundary (task 2085)', () => {
  const TRUSTED_PROXY_ADDRESS = '10.0.0.1'
  const UNTRUSTED_ADDRESS = '203.0.113.7'

  async function buildApp() {
    const app = fastify({ trustProxy: TRUSTED_PROXY_ADDRESS })
    app.decorateRequest('siteResolution', null)
    app.addHook('onRequest', (req: any, _reply, done) => {
      req.siteResolution = resolveRequestSite({
        firstSegment: 'some-page',
        hostname: req.hostname,
        sitesMappings,
        sites,
        exemptSegments: NO_EXEMPT_SEGMENTS
      })
      done()
    })
    app.get('/some-page', async (req: any) => req.siteResolution)
    return app
  }

  test("an untrusted peer's X-Forwarded-Host naming a different site is ignored in favor of Host", async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/some-page',
      remoteAddress: UNTRUSTED_ADDRESS,
      headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
    })
    // -> Falls back to the socket's own `Host`, resolving as the enabled site it actually named --
    //    not the disabled one an attacker tried to steer it toward via the forwarded header.
    assert.deepEqual(res.json(), { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
    await app.close()
  })

  test('the same header from a trusted proxy address still resolves to the forwarded site', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/some-page',
      remoteAddress: TRUSTED_PROXY_ADDRESS,
      headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
    })
    assert.deepEqual(res.json(), { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
    await app.close()
  })

  test('an untrusted peer with no X-Forwarded-Host at all is unaffected -- Host was already authoritative', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/some-page',
      remoteAddress: UNTRUSTED_ADDRESS,
      headers: { host: 'off.example.com' }
    })
    assert.deepEqual(res.json(), { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
    await app.close()
  })
})

/** A stand-in for `FastifyReply` that records the one method `guardSiteEnabled` may call. */
function fakeReply() {
  const calls: { forbidden: string[]; notFound: string[] } = { forbidden: [], notFound: [] }
  const reply: any = {
    forbidden(message: string) {
      calls.forbidden.push(message)
      return reply
    },
    notFound(message: string) {
      calls.notFound.push(message)
      return reply
    }
  }
  return { reply, calls }
}

describe('guardSiteEnabled', () => {
  test('replies 403 and returns true for a resolved-but-disabled site', () => {
    const { reply, calls } = fakeReply()
    const handled = guardSiteEnabled(sites[DISABLED_SITE_ID], reply)
    assert.equal(handled, true)
    assert.deepEqual(calls.forbidden, [SITE_DISABLED_MESSAGE])
  })

  test('does nothing and returns false for an enabled site', () => {
    const { reply, calls } = fakeReply()
    const handled = guardSiteEnabled(sites[ENABLED_SITE_ID], reply)
    assert.equal(handled, false)
    assert.deepEqual(calls.forbidden, [])
  })

  test("does nothing and returns false for a site that does not exist (undefined) — the caller's own lookup answers that", () => {
    const { reply, calls } = fakeReply()
    const handled = guardSiteEnabled(undefined, reply)
    assert.equal(handled, false)
    assert.deepEqual(calls.forbidden, [])
  })

  test('does nothing and returns false for a null site', () => {
    const { reply, calls } = fakeReply()
    const handled = guardSiteEnabled(null, reply)
    assert.equal(handled, false)
    assert.deepEqual(calls.forbidden, [])
  })
})

/**
 * Work package 2075(c): a forwarded host that resolves to a different site than `Host` must not be
 * honored unless the request arrived from a proxy trusted under `security.trustProxy`'s new
 * address/CIDR specification.
 *
 * `resolveRequestSite` itself takes an already-resolved `hostname` string -- it has no header of its
 * own to distrust. What actually decides whether `X-Forwarded-Host` gets to be that string is
 * Fastify's own `request.hostname` getter (`fastify/lib/request.js`), gated on the same `trustProxy`
 * option `backend/index.ts` passes straight through from `WIKI.config.security.trustProxy`. So this
 * spins up a real (unlistened) Fastify instance wired exactly the way `index.ts`'s site-resolution
 * hook is -- `trustProxy` from config, an `onRequest`-time `resolveRequestSite({ hostname: req.hostname,
 * ... })` -- and proves the mechanism end to end via `inject()`, rather than re-describing Fastify's
 * own trust logic as a second implementation here.
 */
describe('trustProxy gates X-Forwarded-Host trust for site resolution', () => {
  async function buildApp(trustProxy: string) {
    const app = fastify({ trustProxy })
    app.get('/some-page', async (req) => {
      return resolveRequestSite({
        firstSegment: 'some-page',
        hostname: req.hostname,
        sitesMappings,
        sites,
        exemptSegments: NO_EXEMPT_SEGMENTS
      })
    })
    await app.ready()
    return app
  }

  test('a request from an untrusted source cannot steer site resolution via X-Forwarded-Host', async () => {
    const app = await buildApp('10.0.0.1')
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/some-page',
        remoteAddress: '203.0.113.9',
        headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
      })
      // -> Ignored in favour of `Host`: resolves to the enabled site the socket's own Host names,
      //    not the disabled one an untrusted client tried to name via X-Forwarded-Host.
      assert.deepEqual(res.json(), { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
    } finally {
      await app.close()
    }
  })

  test('the same header from the trusted proxy address is honored', async () => {
    const app = await buildApp('10.0.0.1')
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/some-page',
        remoteAddress: '10.0.0.1',
        headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
      })
      assert.deepEqual(res.json(), { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
    } finally {
      await app.close()
    }
  })

  test('a request from outside the trusted CIDR range cannot steer site resolution', async () => {
    const app = await buildApp('10.0.0.0/24')
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/some-page',
        remoteAddress: '10.0.1.5',
        headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
      })
      assert.deepEqual(res.json(), { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
    } finally {
      await app.close()
    }
  })

  test('a request from inside the trusted CIDR range is honored', async () => {
    const app = await buildApp('10.0.0.0/24')
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/some-page',
        remoteAddress: '10.0.0.5',
        headers: { host: 'wiki.example.com', 'x-forwarded-host': 'off.example.com' }
      })
      assert.deepEqual(res.json(), { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
    } finally {
      await app.close()
    }
  })
})

/**
 * OpenProject #1587/#1593: `siteEnabledPreHandler` is the single Fastify `preHandler` `api/index.ts`
 * registers for the whole `/_api` tree, replacing nine hand-applied `guardSiteEnabled()` call sites
 * and — for the first time — covering the dozen-plus `:siteId` routes across `pages.ts`, `tree.ts`,
 * `assets.ts`, `comments.ts`, `navigation.ts`, `liveData.ts` and `glossary.ts` that never had a guard
 * at all. Spec D1 folded the unknown-site 404 in here too, replacing 36 hand-written per-route
 * preambles that answered it in two different spellings. Tested as the plain function it is, against
 * a synthetic `req`/`reply`/`done` rather than a booted Fastify app — see `api/index.test.ts` for the
 * companion structural test that calls this same function against every `:siteId` route the API
 * actually declares.
 */
describe('siteEnabledPreHandler', () => {
  let previousWiki: any

  function fakeDone() {
    const calls: unknown[] = []
    const done = (err?: Error) => {
      calls.push(err)
    }
    return { done, calls }
  }

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { sites }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('forbids and never calls done() for a route whose siteId resolves to a disabled site', () => {
    const { reply, calls: forbiddenCalls } = fakeReply()
    const { done, calls: doneCalls } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: DISABLED_SITE_ID } } as any, reply, done)
    assert.deepEqual(forbiddenCalls.forbidden, [SITE_DISABLED_MESSAGE])
    assert.equal(doneCalls.length, 0)
  })

  test('calls done() with no error for a route whose siteId resolves to an enabled site', () => {
    const { reply, calls: forbiddenCalls } = fakeReply()
    const { done, calls: doneCalls } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: ENABLED_SITE_ID } } as any, reply, done)
    assert.deepEqual(forbiddenCalls.forbidden, [])
    assert.deepEqual(doneCalls, [undefined])
  })

  test('calls done() for a route with no siteId param at all — nothing here to guard', () => {
    const { reply, calls: forbiddenCalls } = fakeReply()
    const { done, calls: doneCalls } = fakeDone()
    siteEnabledPreHandler({ params: {} } as any, reply, done)
    assert.deepEqual(forbiddenCalls.forbidden, [])
    assert.deepEqual(doneCalls, [undefined])
  })

  test('404s and never calls done() for a siteId that resolves to no known site (spec D1)', () => {
    const { reply, calls: replyCalls } = fakeReply()
    const { done, calls: doneCalls } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: 'no-such-site' } } as any, reply, done)
    assert.deepEqual(replyCalls.notFound, [SITE_MISSING_MESSAGE])
    assert.deepEqual(replyCalls.forbidden, [])
    assert.equal(doneCalls.length, 0)
  })
})

describe('isHashedAssetFilename', () => {
  // -> Real basenames off a built `assets/_assets` (vite's `[name]-[hash].[ext]` output).
  const hashedSamples = [
    '1c-light.min-BO6Pf1_3.js',
    '3024.min-BqdulyS4.js',
    'AccountMenu-D3c-tApN.js',
    'AccountMenu-jI0Xq9IQ.css',
    'AdminAnalytics-Bq33DEXD.js',
    'AdminAnalytics-_v2YFXZC.css',
    'index-CL_uwIZr.js'
  ]

  for (const name of hashedSamples) {
    test(`hashed build output "${name}" is immutable`, () => {
      assert.equal(isHashedAssetFilename(name), true)
    })
  }

  // -> The 8 entries under `assets/_assets` that are NOT vite build output: `renderer.js` is a
  //    deliberately fixed entry point name (referenced by a static server-rendered page), and the
  //    other 7 are hand-authored trees vite never touches.
  const unhashedSamples = [
    'bg',
    'fonts',
    'icons',
    'illustrations',
    'logo-wikijs.svg',
    'renderer.js',
    'storage',
    'svg'
  ]

  for (const name of unhashedSamples) {
    test(`unhashed entry "${name}" is not immutable`, () => {
      assert.equal(isHashedAssetFilename(name), false)
    })
  }

  test('a short suffix under 8 characters does not count as a hash', () => {
    assert.equal(isHashedAssetFilename('logo-abc1234.svg'), false)
  })

  test('a name with no extension is never hashed, even with a long suffix', () => {
    assert.equal(isHashedAssetFilename('some-long-enough-suffix12345678'), false)
  })

  test('a name with no hyphen at all is not hashed', () => {
    assert.equal(isHashedAssetFilename('renderer.js'), false)
  })
})

describe('maskSensitiveConfig', () => {
  const props = {
    apiKey: fakeProp({ sensitive: true }),
    label: fakeProp({ sensitive: false })
  }

  test('replaces a non-empty sensitive value with the mask', () => {
    const masked = maskSensitiveConfig(props, { apiKey: 'super-secret', label: 'My Provider' })
    assert.deepEqual(masked, { apiKey: SENSITIVE_CONFIG_MASK, label: 'My Provider' })
  })

  test('leaves an empty sensitive value alone — nothing stored, nothing to hide', () => {
    const masked = maskSensitiveConfig(props, { apiKey: '', label: 'My Provider' })
    assert.deepEqual(masked, { apiKey: '', label: 'My Provider' })
  })

  test('leaves a non-string sensitive value alone (e.g. still undefined)', () => {
    const masked = maskSensitiveConfig(props, { label: 'My Provider' })
    assert.deepEqual(masked, { label: 'My Provider' })
  })

  test('does not mutate the config object passed in', () => {
    const config = { apiKey: 'super-secret' }
    maskSensitiveConfig(props, config)
    assert.equal(config.apiKey, 'super-secret')
  })

  test('returns the config unchanged when no prop is declared sensitive', () => {
    const masked = maskSensitiveConfig({ label: fakeProp() }, { label: 'value' })
    assert.deepEqual(masked, { label: 'value' })
  })
})

describe('unmaskSensitiveConfig', () => {
  const props = {
    apiKey: fakeProp({ sensitive: true }),
    label: fakeProp({ sensitive: false })
  }

  test('drops a sensitive key whose incoming value is exactly the mask', () => {
    const cleaned = unmaskSensitiveConfig(props, {
      apiKey: SENSITIVE_CONFIG_MASK,
      label: 'My Provider'
    })
    assert.deepEqual(cleaned, { label: 'My Provider' })
  })

  test('leaves a genuinely new sensitive value alone', () => {
    const cleaned = unmaskSensitiveConfig(props, { apiKey: 'brand-new-secret' })
    assert.deepEqual(cleaned, { apiKey: 'brand-new-secret' })
  })

  test('leaves a non-sensitive value equal to the mask string alone', () => {
    const cleaned = unmaskSensitiveConfig(props, { label: SENSITIVE_CONFIG_MASK })
    assert.deepEqual(cleaned, { label: SENSITIVE_CONFIG_MASK })
  })

  test('does not mutate the incoming object passed in', () => {
    const incoming = { apiKey: SENSITIVE_CONFIG_MASK }
    unmaskSensitiveConfig(props, incoming)
    assert.equal(incoming.apiKey, SENSITIVE_CONFIG_MASK)
  })
})
