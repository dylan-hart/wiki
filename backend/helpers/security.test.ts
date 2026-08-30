import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import {
  corsOrigin,
  corsOptions,
  findUnknownCspDirective,
  isSameOriginHeader,
  SESSION_COOKIE_NAME,
  shouldBlockCrossOriginApiRequest
} from './security.ts'

// -> corsOrigin()'s REGEX branch logs through the WIKI global on an invalid pattern; stub just
//    enough of it, the same way rateLimit.test.ts does for its own WIKI-touching helpers.
;(globalThis as any).WIKI = { logger: { warn: mock.fn() } }

describe('corsOrigin', () => {
  test('OFF (and unrecognized) modes deny cross-origin', () => {
    assert.equal(corsOrigin({ corsMode: 'OFF' }), false)
    assert.equal(corsOrigin({ corsMode: undefined }), false)
  })

  test('REFLECT reflects any origin', () => {
    assert.equal(corsOrigin({ corsMode: 'REFLECT' }), true)
  })

  test('HOSTNAMES splits the configured list on commas and newlines', () => {
    assert.deepEqual(
      corsOrigin({
        corsMode: 'HOSTNAMES',
        corsConfig: 'https://a.example, https://b.example\nhttps://c.example'
      }),
      ['https://a.example', 'https://b.example', 'https://c.example']
    )
  })

  test('REGEX compiles the configured pattern', () => {
    const result = corsOrigin({ corsMode: 'REGEX', corsConfig: '^https://.*\\.example$' })
    assert.ok(result instanceof RegExp)
    assert.equal((result as RegExp).test('https://foo.example'), true)
  })

  test('REGEX falls back to same-origin only on an invalid pattern', () => {
    assert.equal(corsOrigin({ corsMode: 'REGEX', corsConfig: '(' }), false)
  })
})

describe('corsOptions', () => {
  // -> `/_api` routes span the full CRUD surface (55+ routes across backend/api/*.ts use PUT,
  //    PATCH or DELETE), so the CORS registration these options feed must clear preflight for all
  //    three, plus the Authorization/Content-Type headers a cross-origin API client sends.
  test('methods cover the full CRUD surface the API routes use', () => {
    const options = corsOptions({ corsMode: 'OFF' })
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.ok(options.methods.includes(method), `expected methods to include ${method}`)
    }
  })

  test('allowedHeaders clears preflight for a Bearer token and a JSON body', () => {
    const options = corsOptions({ corsMode: 'OFF' })
    assert.ok(options.allowedHeaders.includes('Authorization'))
    assert.ok(options.allowedHeaders.includes('Content-Type'))
  })

  test('origin delegates to corsOrigin', () => {
    assert.equal(corsOptions({ corsMode: 'REFLECT' }).origin, true)
    assert.equal(corsOptions({ corsMode: 'OFF' }).origin, false)
  })
})

describe('corsOptions preflight (integration)', () => {
  // -> The unit tests above assert on the `options` object `corsOptions()` returns; this spins up a
  //    real `@fastify/cors`-registered Fastify instance (same pattern as `api/sites.test.ts`) and
  //    drives it through `.inject()`, so it exercises the thing a browser actually does before a
  //    cross-origin `PUT`/`DELETE` — a preflight `OPTIONS` carrying `Access-Control-Request-Method` —
  //    rather than just the config object index.ts hands the plugin.
  async function buildApp() {
    const app = fastify()
    await app.register(
      fastifyCors,
      corsOptions({ corsMode: 'HOSTNAMES', corsConfig: 'https://client.example' })
    )
    app.put('/_api/pages/1', async () => ({ ok: true }))
    app.delete('/_api/pages/1', async () => ({ ok: true }))
    await app.ready()
    return app
  }

  for (const method of ['PUT', 'DELETE']) {
    test(`an allowed origin's ${method} preflight reports ${method} in Access-Control-Allow-Methods`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'OPTIONS',
          url: '/_api/pages/1',
          headers: {
            Origin: 'https://client.example',
            'Access-Control-Request-Method': method
          }
        })
        assert.equal(res.statusCode, 204)
        assert.equal(res.headers['access-control-allow-origin'], 'https://client.example')
        const allowed = String(res.headers['access-control-allow-methods'])
        assert.ok(
          allowed
            .split(',')
            .map((m) => m.trim())
            .includes(method),
          `expected Access-Control-Allow-Methods (${allowed}) to include ${method}`
        )
      } finally {
        await app.close()
      }
    })
  }
})

/**
 * OpenProject #1360/#2154 (2026-08-24 security audit §10): `models/security.ts#validate` used to
 * accept any directive name at all, so a typo saved while `enforceCsp` was off would sit silently
 * wrong until an operator turned the toggle on.
 */
describe('findUnknownCspDirective', () => {
  test('returns null when every directive is one a browser recognises', () => {
    assert.equal(
      findUnknownCspDirective("default-src 'self'; object-src 'none'; base-uri 'self'"),
      null
    )
  })

  test('returns null for a directive with no value, such as upgrade-insecure-requests', () => {
    assert.equal(findUnknownCspDirective('upgrade-insecure-requests'), null)
  })

  test('is case-insensitive, matching parseCspDirectives', () => {
    assert.equal(findUnknownCspDirective("DEFAULT-SRC 'self'"), null)
  })

  test("flags a typo'd directive name", () => {
    assert.equal(findUnknownCspDirective("scirpt-src 'self'"), 'scirpt-src')
  })

  test('flags a header name that is not a CSP directive at all', () => {
    assert.equal(findUnknownCspDirective('x-frame-options DENY'), 'x-frame-options')
  })

  test('returns the first unknown directive when more than one directive is present', () => {
    assert.equal(
      findUnknownCspDirective("default-src 'self'; not-a-directive 'x'"),
      'not-a-directive'
    )
  })
})

describe('SESSION_COOKIE_NAME', () => {
  test('carries the __Host- prefix, since that is what makes it real', () => {
    assert.equal(SESSION_COOKIE_NAME, '__Host-wikiSession')
  })
})

describe('isSameOriginHeader', () => {
  test('agrees when the Origin header names the same host', () => {
    assert.equal(isSameOriginHeader('https://wiki.example.com', 'wiki.example.com'), true)
  })

  test('agrees when both carry the same explicit port', () => {
    assert.equal(isSameOriginHeader('https://wiki.example.com:8080', 'wiki.example.com:8080'), true)
  })

  test('disagrees for a foreign origin, same-site sibling included', () => {
    assert.equal(isSameOriginHeader('https://evil.example.com', 'wiki.example.com'), false)
    assert.equal(isSameOriginHeader('https://sibling.example.com', 'wiki.example.com'), false)
  })

  test('disagrees on a port mismatch alone', () => {
    assert.equal(isSameOriginHeader('https://wiki.example.com:8080', 'wiki.example.com'), false)
  })

  test('is not scheme-sensitive: only the host is compared', () => {
    assert.equal(isSameOriginHeader('http://wiki.example.com', 'wiki.example.com'), true)
  })

  test('fails closed on a missing Origin header', () => {
    assert.equal(isSameOriginHeader(undefined, 'wiki.example.com'), false)
  })

  test('fails closed on a missing host to compare against', () => {
    assert.equal(isSameOriginHeader('https://wiki.example.com', undefined), false)
  })

  test('fails closed on an Origin header that does not parse as a URL', () => {
    assert.equal(isSameOriginHeader('not-a-url', 'wiki.example.com'), false)
  })

  test('fails closed on the opaque "null" Origin a sandboxed context sends', () => {
    assert.equal(isSameOriginHeader('null', 'wiki.example.com'), false)
  })
})

describe('shouldBlockCrossOriginApiRequest', () => {
  function req(overrides: Partial<Parameters<typeof shouldBlockCrossOriginApiRequest>[0]> = {}) {
    return {
      url: '/_api/users',
      method: 'POST',
      cookies: { [SESSION_COOKIE_NAME]: 'abc123.sig' },
      headers: {},
      host: 'wiki.example.com',
      ...overrides
    }
  }

  test('allows a same-origin state-changing request (Origin agrees with host)', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(req({ headers: { origin: 'https://wiki.example.com' } })),
      false
    )
  })

  test('allows a same-origin request signalled purely by Sec-Fetch-Site', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(req({ headers: { 'sec-fetch-site': 'same-origin' } })),
      false
    )
  })

  test('blocks a cross-origin state-changing request', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(req({ headers: { origin: 'https://evil.example.com' } })),
      true
    )
  })

  test('blocks POST /_api/system/sessions/invalidate from a foreign origin with a valid session cookie', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(
        req({
          url: '/_api/system/sessions/invalidate',
          headers: { origin: 'https://evil.example.com' }
        })
      ),
      true
    )
  })

  test('blocks POST /_api/users from a foreign origin with a valid session cookie', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(
        req({ url: '/_api/users', headers: { origin: 'https://evil.example.com' } })
      ),
      true
    )
  })

  test('blocks a missing Origin (and no Sec-Fetch-Site) on an otherwise-eligible request', () => {
    assert.equal(shouldBlockCrossOriginApiRequest(req({ headers: {} })), true)
  })

  test('exempts a bearer-authenticated request regardless of Origin', () => {
    assert.equal(
      shouldBlockCrossOriginApiRequest(
        req({ apiKey: { id: 'key-1' }, headers: { origin: 'https://evil.example.com' } })
      ),
      false
    )
  })

  test('never blocks GET or HEAD', () => {
    assert.equal(shouldBlockCrossOriginApiRequest(req({ method: 'GET', headers: {} })), false)
    assert.equal(shouldBlockCrossOriginApiRequest(req({ method: 'HEAD', headers: {} })), false)
  })

  test('never blocks a request outside /_api/', () => {
    assert.equal(shouldBlockCrossOriginApiRequest(req({ url: '/_site/current/logo' })), false)
  })

  test('never blocks a request carrying no session cookie at all', () => {
    assert.equal(shouldBlockCrossOriginApiRequest(req({ cookies: {} })), false)
  })
})
