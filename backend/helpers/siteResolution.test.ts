import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import {
  guardSiteEnabled,
  normalizeHostname,
  resolveRequestSite,
  siteEnabledPreHandler,
  siteIdForHostname,
  SITE_DISABLED_MESSAGE,
  SITE_MISSING_MESSAGE
} from './siteResolution.ts'

import { installTestWiki } from '../test/mocks.ts'

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

  test('leaves the wildcard mapping key untouched', () => {
    assert.equal(normalizeHostname('*'), '*')
  })
})

describe('siteIdForHostname', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({ sites, sitesMappings })
  })

  after(() => {
    wikiHandle.restore()
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

/**
 * Task 2085: an unauthenticated client naming another site's hostname in `X-Forwarded-Host` must not
 * be able to steer site resolution, unless it genuinely arrived through a proxy address the instance
 * has been told to trust. `resolveRequestSite` itself trusts whatever `hostname` it is handed (see its
 * doc comment) -- the refusal happens one layer up, in Fastify's own `trustProxy`-aware
 * `request.hostname` getter, exercised here exactly as `core/http/siteRouting.ts`'s site-resolution hook uses
 * it: a
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
  let wikiHandle: { restore(): void }

  function fakeDone() {
    const calls: unknown[] = []
    const done = (err?: Error) => {
      calls.push(err)
    }
    return { done, calls }
  }

  before(() => {
    wikiHandle = installTestWiki({ sites })
  })

  after(() => {
    wikiHandle.restore()
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
