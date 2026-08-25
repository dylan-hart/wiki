import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifySensible from '@fastify/sensible'
import { corsOrigin, corsOptions, isSameOriginRequest } from './security.ts'

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

describe('isSameOriginRequest', () => {
  test('a matching Origin header is allowed', () => {
    assert.equal(isSameOriginRequest({ origin: 'https://wiki.example' }, 'wiki.example'), true)
  })

  test('a cross-origin Origin header is rejected', () => {
    assert.equal(isSameOriginRequest({ origin: 'https://attacker.example' }, 'wiki.example'), false)
  })

  test('Origin comparison includes the port', () => {
    assert.equal(
      isSameOriginRequest({ origin: 'https://wiki.example:8443' }, 'wiki.example'),
      false
    )
    assert.equal(
      isSameOriginRequest({ origin: 'https://wiki.example:8443' }, 'wiki.example:8443'),
      true
    )
  })

  test('an unparsable Origin header is rejected', () => {
    assert.equal(isSameOriginRequest({ origin: 'not-a-url' }, 'wiki.example'), false)
  })

  test('a missing Origin falls back to Sec-Fetch-Site: same-origin', () => {
    assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }, 'wiki.example'), true)
  })

  test('a missing Origin with a cross-site Sec-Fetch-Site is rejected', () => {
    assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }, 'wiki.example'), false)
    assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'none' }, 'wiki.example'), false)
  })

  test('neither header present fails closed', () => {
    assert.equal(isSameOriginRequest({}, 'wiki.example'), false)
  })

  test('Origin takes priority over Sec-Fetch-Site when both are present', () => {
    assert.equal(
      isSameOriginRequest(
        { origin: 'https://wiki.example', 'sec-fetch-site': 'cross-site' },
        'wiki.example'
      ),
      true
    )
  })
})

describe('origin check hook (integration, task 2118)', () => {
  /*
    Mirrors index.ts's actual hook chain for this concern, in order: the API Key Authentication hook
    sets `req.apiKey` from a Bearer token; a stand-in for @fastify/session (a test-only header, since
    booting the real session store here would just be re-describing it) simulates what would already
    be parsed off the cookie by this point; then the origin-check hook itself — the exact conditional
    shape at index.ts's "Origin Check (task 2118)" section, built on the `isSameOriginRequest` helper
    already covered in isolation above. `POST /_api/system/sessions/invalidate` and `POST
    /_api/users` are the two endpoints task 2118's Done-when criteria names by path.
  */
  async function buildApp() {
    const app = fastify()
    await app.register(fastifySensible)
    app.decorateRequest('apiKey', null)

    app.addHook('onRequest', async (req) => {
      const header = req.headers.authorization
      if (header?.startsWith('Bearer ')) {
        req.apiKey = { id: 'test-key' } as any
      }
    })

    app.addHook('onRequest', async (req) => {
      if (req.headers['x-test-session'] === 'authenticated') {
        req.session = { authenticated: true } as any
      }
    })

    app.addHook('onRequest', (req, reply, done) => {
      if (!req.url.startsWith('/_api/') || req.method === 'GET' || req.method === 'HEAD') {
        return done()
      }
      if (req.apiKey) {
        return done()
      }
      if (!(req.session as any)?.authenticated) {
        return done()
      }
      if (!isSameOriginRequest(req.headers, req.host)) {
        return reply.forbidden()
      }
      done()
    })

    app.post('/_api/system/sessions/invalidate', async () => ({ ok: true }))
    app.post('/_api/users', async () => ({ ok: true }))

    await app.ready()
    return app
  }

  for (const url of ['/_api/system/sessions/invalidate', '/_api/users']) {
    test(`${url}: a foreign Origin with a valid session cookie is refused`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: {
            host: 'wiki.example',
            origin: 'https://attacker.example',
            'x-test-session': 'authenticated'
          }
        })
        assert.equal(res.statusCode, 403)
      } finally {
        await app.close()
      }
    })

    test(`${url}: a same-origin request with a valid session cookie is allowed through`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: {
            host: 'wiki.example',
            origin: 'https://wiki.example',
            'x-test-session': 'authenticated'
          }
        })
        assert.equal(res.statusCode, 200)
      } finally {
        await app.close()
      }
    })

    test(`${url}: a session cookie with no Origin/Sec-Fetch-Site is refused (fails closed)`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: {
            host: 'wiki.example',
            'x-test-session': 'authenticated'
          }
        })
        assert.equal(res.statusCode, 403)
      } finally {
        await app.close()
      }
    })

    test(`${url}: a Bearer-authenticated request is exempt regardless of Origin`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: {
            host: 'wiki.example',
            origin: 'https://attacker.example',
            authorization: 'Bearer test-token'
          }
        })
        assert.equal(res.statusCode, 200)
      } finally {
        await app.close()
      }
    })

    test(`${url}: an unauthenticated request (no session cookie) is not blocked by this check`, async () => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: {
            host: 'wiki.example',
            origin: 'https://attacker.example'
          }
        })
        assert.equal(res.statusCode, 200)
      } finally {
        await app.close()
      }
    })
  }

  test('GET requests are not subject to the origin check even with a foreign Origin', async () => {
    const app = fastify()
    await app.register(fastifySensible)
    app.decorateRequest('apiKey', null)
    app.addHook('onRequest', async (req) => {
      if (req.headers['x-test-session'] === 'authenticated') {
        req.session = { authenticated: true } as any
      }
    })
    app.addHook('onRequest', (req, reply, done) => {
      if (!req.url.startsWith('/_api/') || req.method === 'GET' || req.method === 'HEAD') {
        return done()
      }
      if (!(req.session as any)?.authenticated) {
        return done()
      }
      if (!isSameOriginRequest(req.headers, req.host)) {
        return reply.forbidden()
      }
      done()
    })
    app.get('/_api/users', async () => ({ ok: true }))
    await app.ready()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/_api/users',
        headers: {
          host: 'wiki.example',
          origin: 'https://attacker.example',
          'x-test-session': 'authenticated'
        }
      })
      assert.equal(res.statusCode, 200)
    } finally {
      await app.close()
    }
  })
})
