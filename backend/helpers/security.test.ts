import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import { load } from 'js-yaml'
import {
  corsOrigin,
  corsOptions,
  inlineScriptHashSources,
  isSameOriginHeader,
  needsSvgCsp,
  parseCspDirectives,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_INSECURE,
  sessionCookieName,
  shouldBlockCrossOriginApiRequest
} from './security.ts'

import { installTestWiki } from '../test/mocks.ts'

// -> corsOrigin()'s REGEX branch logs through the WIKI global on an invalid pattern; stub just
//    enough of it, the same way rateLimit.test.ts does for its own WIKI-touching helpers.
//    `config.security` is here for `sessionCookieName()` -- most describes never touch it, but it has
//    to exist so a bare read doesn't throw.
installTestWiki({ logger: { warn: mock.fn() }, config: { security: {} } })

/**
 * Unit tests for WP #2158/#2161 (part of #2154): `parseCspDirectives` used to accept any token as a
 * directive name, so a typo'd or invented one was stored -- and enforced -- as silently less policy
 * than the operator intended. It now throws, naming the offending token, and this is also where the
 * shipped `backend/base.yml` default is asserted to actually parse, since that string is otherwise
 * just YAML nobody exercises.
 */
describe('parseCspDirectives', () => {
  test('the shipped default (empty string) parses to no directives', () => {
    assert.deepEqual(parseCspDirectives(''), {})
  })

  test('parses a valid multi-directive policy', () => {
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

  test('directive names are case-insensitive', () => {
    assert.deepEqual(parseCspDirectives("DEFAULT-SRC 'self'"), { 'default-src': ["'self'"] })
  })

  test('empty and whitespace-only chunks are ignored', () => {
    assert.deepEqual(parseCspDirectives(" default-src 'self'; ; "), { 'default-src': ["'self'"] })
  })

  test('rejects an unknown directive name, naming it', () => {
    assert.throws(() => parseCspDirectives("srcipt-src 'self'"), /Unknown.*"srcipt-src"/)
  })

  test('rejects an unknown directive even alongside otherwise-valid ones', () => {
    assert.throws(
      () => parseCspDirectives("default-src 'self'; not-a-real-directive 'none'"),
      /"not-a-real-directive"/
    )
  })

  test('the shipped backend/base.yml default parses cleanly into the expected directive map', () => {
    const config: any = load(readFileSync(path.join(import.meta.dirname, '../base.yml'), 'utf8'))
    const shipped = config.defaults.config.security.cspDirectives as string
    assert.ok(shipped.length > 0, 'expected base.yml to ship a non-empty default')

    const parsed = parseCspDirectives(shipped)

    // -> The "at minimum" baseline the WP calls for, plus what Monaco, the blocks loader and KaTeX
    //    actually need -- see the comment above `cspDirectives` in base.yml for the full reasoning
    //    per directive.
    for (const expected of [
      'default-src',
      'object-src',
      'base-uri',
      'frame-ancestors',
      'script-src',
      'style-src',
      'worker-src',
      'img-src',
      'connect-src'
    ]) {
      assert.ok(expected in parsed, `expected the shipped policy to set ${expected}`)
    }
    assert.deepEqual(parsed['object-src'], ["'none'"])
    assert.deepEqual(parsed['base-uri'], ["'self'"])
    assert.deepEqual(parsed['frame-ancestors'], ["'none'"])
  })
})

/**
 * Regression coverage for the app shell's own two inline `<script>` blocks (the Temporal-polyfill
 * feature-detect check and `temporalPolyfillChunkPlugin`'s substituted chunk-url assignment) tripping
 * a `script-src 'self'` policy with no `'unsafe-inline'` -- the shipped default -- and breaking the
 * app shell outright the moment `enforceCsp` is turned on (caught by `e2e/tests/csp.spec.js`).
 */
describe('inlineScriptHashSources', () => {
  test('hashes an inline script with no src, matching a manual SHA-256/base64 computation', () => {
    const content = "window.__wikiTemporalPolyfillUrl = '/assets/global.esm-abc123.js'"
    const html = `<html><head><script>${content}</script></head></html>`
    const expected = `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`

    assert.deepEqual(inlineScriptHashSources(html), [expected])
  })

  test('skips a script tag that carries a src attribute', () => {
    const html = '<html><head><script src="/_assets/main.js"></script></head></html>'
    assert.deepEqual(inlineScriptHashSources(html), [])
  })

  test('skips a module script that carries a src attribute, other attributes present', () => {
    const html = '<script type="module" crossorigin src="/_assets/main-abc.js"></script>'
    assert.deepEqual(inlineScriptHashSources(html), [])
  })

  test('hashes every inline script block, in document order', () => {
    const first = "var a = 'one'"
    const second = "var b = 'two'"
    const html = `<script>${first}</script><div>x</div><script type="text/javascript">${second}</script>`

    assert.deepEqual(inlineScriptHashSources(html), [
      `'sha256-${createHash('sha256').update(first, 'utf8').digest('base64')}'`,
      `'sha256-${createHash('sha256').update(second, 'utf8').digest('base64')}'`
    ])
  })

  test('returns an empty array for html with no script tags', () => {
    assert.deepEqual(inlineScriptHashSources('<html><body>Hello</body></html>'), [])
  })

  test('the built app shell (if present) yields at least the two known inline scripts', () => {
    const appShellPath = path.join(import.meta.dirname, '../../assets/index.html')
    let html: string
    try {
      html = readFileSync(appShellPath, 'utf8')
    } catch {
      // -> No `npm run build` has produced `assets/index.html` in this environment -- the general
      //    cases above already cover the hashing logic itself.
      return
    }
    assert.ok(inlineScriptHashSources(html).length >= 2)
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

  test('HOSTNAMES normalizes a bare hostname entry into a full https origin', () => {
    assert.deepEqual(corsOrigin({ corsMode: 'HOSTNAMES', corsConfig: 'wiki.example.com' }), [
      'https://wiki.example.com'
    ])
  })

  test('HOSTNAMES leaves an entry that already names a scheme untouched', () => {
    assert.deepEqual(
      corsOrigin({
        corsMode: 'HOSTNAMES',
        corsConfig: 'http://wiki.example.com, wiki.other.example'
      }),
      ['http://wiki.example.com', 'https://wiki.other.example']
    )
  })

  test('REGEX compiles the configured pattern', () => {
    const result = corsOrigin({ corsMode: 'REGEX', corsConfig: '^https://.*\\.example$' })
    assert.ok(result instanceof RegExp)
    assert.equal((result as RegExp).test('https://foo.example'), true)
  })

  test('REGEX anchors an unanchored operator pattern so it cannot match as a substring', () => {
    const result = corsOrigin({
      corsMode: 'REGEX',
      corsConfig: 'https://wiki\\.example\\.com'
    }) as RegExp
    assert.ok(result instanceof RegExp)
    assert.equal(result.test('https://wiki.example.com'), true)
    assert.equal(result.test('https://wiki.example.com.attacker.test'), false)
    assert.equal(result.test('https://evil.test/?x=wiki.example.com'), false)
  })

  test('REGEX leaves an already-anchored operator pattern as written', () => {
    const result = corsOrigin({
      corsMode: 'REGEX',
      corsConfig: '^https://.*\\.example$'
    }) as RegExp
    // -> Not double-wrapped: a leading `^`/trailing `$` the operator already wrote is stripped
    //    before re-anchoring, so the effective pattern is unchanged rather than `^^...$$`. The
    //    body is still wrapped in a non-capturing group (see the alternation test below), so the
    //    resulting source reflects that wrap even though the matched behavior is identical.
    assert.equal(result.source, new RegExp('^(?:https://.*\\.example)$').source)
    assert.equal(result.test('https://wiki.example'), true)
    assert.equal(result.test('https://wiki.example.attacker.test'), false)
  })

  test('REGEX fully anchors a pattern with top-level alternation', () => {
    // -> `^A|B$` only anchors the left edge of the first alternative and the right edge of the
    //    last one — `B` alone is left unanchored and still substring-matchable anywhere in the
    //    Origin header. Wrapping the whole pattern in a non-capturing group before anchoring
    //    (`^(?:A|B)$`) fixes that: both alternatives are now fully anchored.
    const result = corsOrigin({
      corsMode: 'REGEX',
      corsConfig: 'https://a\\.example|https://b\\.example'
    }) as RegExp
    assert.ok(result instanceof RegExp)
    assert.equal(result.test('https://a.example'), true)
    assert.equal(result.test('https://b.example'), true)
    // -> Previously matched via the unanchored right-hand alternative's bare substring test.
    assert.equal(result.test('https://evil.test/?x=https://b.example'), false)
    assert.equal(result.test('https://b.example.attacker.test'), false)
    // -> Previously matched via the unanchored left-hand alternative's bare substring test too,
    //    since only ITS left edge was anchored, not its right edge.
    assert.equal(result.test('https://a.example.attacker.test'), false)
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

describe('needsSvgCsp', () => {
  // -> OpenProject #2157: the two routes that serve stored/uploaded bytes back to a requester by
  //    extension (`controllers/files.ts`, `api/assets.ts`'s `/content`) both decide whether to
  //    attach `SVG_CSP` through this one predicate, so it is what's actually under test — not any
  //    one route's wiring of it.
  test('recognizes svg', () => {
    assert.equal(needsSvgCsp('svg'), true)
  })

  test('recognizes html, htm and xhtml, case-insensitively', () => {
    assert.equal(needsSvgCsp('html'), true)
    assert.equal(needsSvgCsp('htm'), true)
    assert.equal(needsSvgCsp('xhtml'), true)
    assert.equal(needsSvgCsp('SVG'), true)
    assert.equal(needsSvgCsp('HTML'), true)
  })

  test('does not flag an ordinary image or binary extension', () => {
    assert.equal(needsSvgCsp('png'), false)
    assert.equal(needsSvgCsp('zip'), false)
    assert.equal(needsSvgCsp('bin'), false)
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

describe('SESSION_COOKIE_NAME', () => {
  test('carries the __Host- prefix, since that is what makes it real', () => {
    assert.equal(SESSION_COOKIE_NAME, '__Host-wikiSession')
  })
})

/**
 * Regression coverage for the boot-order/cookie bug (OpenProject bug report, 2026-08-31): task 2109
 * pinned the session cookie `Secure`/`__Host-` unconditionally on the assumption that a plain
 * `http://localhost` dev instance still worked, since browsers treat loopback as a trustworthy origin.
 * That assumption was wrong -- `@fastify/session`'s own `onSend` hook refuses to ever emit a
 * `Secure`-flagged cookie unless it saw the connection itself as TLS (`request.protocol === 'https'`),
 * which a bare, proxy-less HTTP server never is, loopback or not -- so login silently never set a
 * cookie at all. `security.cookieSecure: false` is the fix; `sessionCookieName()` is what switches the
 * name to match it (a `__Host-`-prefixed cookie without `Secure` is rejected outright by the browser,
 * so the name has to drop the prefix too, not just the attribute).
 */
describe('sessionCookieName', () => {
  test('defaults to the hardened __Host- name when security.cookieSecure is unset', () => {
    ;(globalThis as any).WIKI.config.security = {}
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME)
  })

  test('stays hardened when security.cookieSecure is explicitly true', () => {
    ;(globalThis as any).WIKI.config.security = { cookieSecure: true }
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME)
  })

  test('drops the __Host- prefix when security.cookieSecure is false', () => {
    ;(globalThis as any).WIKI.config.security = { cookieSecure: false }
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME_INSECURE)
  })
})

/**
 * Proves the actual mechanism, not just the config toggle: a real `@fastify/session` instance,
 * registered exactly the way `index.ts` registers it (same cookie options, same `secure` wiring),
 * driven with a real plain-HTTP request via `.inject()`. `secure: true` (the default, matching
 * `security.cookieSecure` unset) reproduces the reported bug -- no `Set-Cookie` at all. `secure: false`
 * (matching `security.cookieSecure: false`) is what actually fixes it.
 */
describe('session cookie emission over plain HTTP (integration)', () => {
  async function buildApp(secure: boolean) {
    const data = new Map<string, any>()
    const app = fastify()
    await app.register(fastifyCookie, { secret: 'a'.repeat(32), hook: 'onRequest' })
    await app.register(fastifySession, {
      secret: 'a'.repeat(32),
      cookieName: secure ? SESSION_COOKIE_NAME : SESSION_COOKIE_NAME_INSECURE,
      cookie: { httpOnly: true, maxAge: 60000, secure, sameSite: 'lax' },
      saveUninitialized: false,
      store: {
        async get(id: string, clb: (err: any, result?: any) => void) {
          clb(null, data.get(id))
        },
        async set(id: string, val: any, clb: (err: any, result?: any) => void) {
          data.set(id, val)
          clb(null)
        },
        async destroy(id: string, clb: (err: any, result?: any) => void) {
          data.delete(id)
          clb(null)
        }
      }
    })
    app.put('/login', async (req: any) => {
      await req.session.regenerate()
      req.session.authenticated = true
      return { ok: true }
    })
    await app.ready()
    return app
  }

  test('secure:true over plain HTTP never sets a cookie -- the reported bug', async () => {
    const app = await buildApp(true)
    try {
      const res = await app.inject({ method: 'PUT', url: '/login' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await app.close()
    }
  })

  test('secure:false over plain HTTP sets the cookie -- what security.cookieSecure:false fixes', async () => {
    const app = await buildApp(false)
    try {
      const res = await app.inject({ method: 'PUT', url: '/login' })
      assert.equal(res.statusCode, 200)
      const setCookie = res.headers['set-cookie']
      assert.ok(setCookie, 'expected a Set-Cookie header')
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie
      assert.ok(cookieStr.startsWith(`${SESSION_COOKIE_NAME_INSECURE}=`))
    } finally {
      await app.close()
    }
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
