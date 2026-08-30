import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import {
  defaultLocale,
  guardSiteEnabled,
  localePrefixRedirectTarget,
  localePrefixStripTarget,
  localizedPagePath,
  matchLocaleCode,
  normalizeHostname,
  requestOrigin,
  resolveRequestSite,
  shouldPrefixLocale,
  SITE_DISABLED_MESSAGE,
  stripLocalePrefix,
  type LocaleRoutingConfig
} from './common.ts'

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

describe('resolveRequestSite', () => {
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

/** A stand-in for `FastifyReply` that records the one method `guardSiteEnabled` may call. */
function fakeReply() {
  const calls: { forbidden: string[] } = { forbidden: [] }
  const reply: any = {
    forbidden(message: string) {
      calls.forbidden.push(message)
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
