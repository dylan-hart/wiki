import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { corsOrigin, corsOptions } from './security.ts'

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
