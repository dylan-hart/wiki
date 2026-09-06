import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeLikePattern,
  isHashedAssetFilename,
  isSameOriginWebSocketHandshake,
  isUniqueViolation,
  requestOrigin
} from './common.ts'

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

  // -> The 7 entries under `assets/_assets` that are NOT vite build output: `renderer.js` is a
  //    deliberately fixed entry point name (referenced by a static server-rendered page), and the
  //    other 6 are hand-authored trees vite never touches. (`bg/` was an eighth until the login
  //    background it held became a backend-owned branding fallback — see `controllers/site.ts`'s
  //    `SITE_ASSET_FALLBACKS`, OpenProject #2611.)
  const unhashedSamples = [
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
