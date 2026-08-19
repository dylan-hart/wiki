import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardSiteEnabled,
  localePrefixRedirectTarget,
  resolveRequestSite,
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
