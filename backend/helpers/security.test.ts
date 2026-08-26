import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import { corsOrigin, corsOptions, parseCspDirectives } from './security.ts'

// -> corsOrigin()'s REGEX branch logs through the WIKI global on an invalid pattern; stub just
//    enough of it, the same way rateLimit.test.ts does for its own WIKI-touching helpers.
;(globalThis as any).WIKI = { logger: { warn: mock.fn() } }

describe('parseCspDirectives', () => {
  test('parses a basic policy string into helmet directive lists', () => {
    assert.deepEqual(parseCspDirectives("default-src 'self'; img-src * data:"), {
      'default-src': ["'self'"],
      'img-src': ['*', 'data:']
    })
  })

  test('a directive with no value maps to an empty list', () => {
    assert.deepEqual(parseCspDirectives('upgrade-insecure-requests'), {
      'upgrade-insecure-requests': []
    })
  })

  /**
   * OpenProject #2158: `base.yml` ships `cspDirectives: ''` alongside `enforceCsp: false`, so a
   * fresh instance sends no CSP header at all -- there was no suggested, let alone tested, policy
   * anywhere to start from. This reads the real shipped default straight out of `base.yml` (rather
   * than a copy hardcoded here, which could silently drift from it) and asserts it actually parses
   * into a directive map covering what the core app needs: a locked-down `default-src`, and
   * `worker-src`/`script-src`/`style-src`/`img-src`/`connect-src` allowances for Monaco, same-origin
   * blocks, and blocks (like `block-kroki`/`block-plantuml`) that call out to a configurable
   * external server by design.
   */
  test('the shipped base.yml default parses into a known-good directive map', () => {
    const baseYml = load(
      readFileSync(path.join(import.meta.dirname, '..', 'base.yml'), 'utf8')
    ) as any
    const defaultValue = baseYml.defaults.config.security.cspDirectives

    assert.equal(typeof defaultValue, 'string')
    assert.notEqual(defaultValue, '', 'a known-good default must not be empty')

    const directives = parseCspDirectives(defaultValue)

    assert.deepEqual(directives['default-src'], ["'self'"])
    assert.deepEqual(directives['object-src'], ["'none'"])
    assert.deepEqual(directives['base-uri'], ["'self'"])
    assert.deepEqual(directives['frame-ancestors'], ["'none'"])
    assert.deepEqual(directives['script-src'], ["'self'"])
    assert.ok(
      directives['worker-src']?.includes("'self'"),
      'worker-src must allow same-origin (Monaco)'
    )
    assert.ok(directives['worker-src']?.includes('blob:'), 'worker-src must allow blob: (Monaco)')
    assert.ok(directives['style-src']?.includes("'self'"))
    assert.ok(directives['img-src']?.includes("'self'"))
    assert.ok(
      directives['img-src']?.includes('https:'),
      'img-src must allow https: for externally-configurable diagram servers and embedded content images'
    )
    assert.ok(
      directives['connect-src']?.includes('https:'),
      'connect-src must allow https: for externally-configurable diagram servers (block-kroki, block-plantuml)'
    )
  })
})

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
