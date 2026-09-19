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
  appendCspDirective,
  corsOrigin,
  corsOptions,
  frameAncestorsDirective,
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

// -> `corsOrigin()`'s REGEX branch logs through the CARDINAL global on an invalid pattern, and
//    `sessionCookieName()` reads `config.security`; both have to exist even though most describes
//    below never touch them.
installTestWiki({ logger: { warn: mock.fn() }, config: { security: {} } })

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
 * The app shell carries two inline `<script>` blocks, which `script-src 'self'` with no
 * `'unsafe-inline'` -- the shipped default -- breaks outright once `enforceCsp` is on. Hashing them
 * into the policy is what keeps the shell loading.
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
      // -> No `npm run build` in this environment; the cases above cover the hashing itself.
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
    // -> An operator's own `^`/`$` is stripped before re-anchoring, so the source reads `^(?:…)$`
    //    rather than `^^…$$`. The non-capturing wrap is what the alternation case below needs.
    assert.equal(result.source, new RegExp('^(?:https://.*\\.example)$').source)
    assert.equal(result.test('https://wiki.example'), true)
    assert.equal(result.test('https://wiki.example.attacker.test'), false)
  })

  test('REGEX fully anchors a pattern with top-level alternation', () => {
    // -> `^A|B$` anchors only the first alternative's left edge and the last one's right edge,
    //    leaving each substring-matchable inside an Origin header; `^(?:A|B)$` anchors both.
    const result = corsOrigin({
      corsMode: 'REGEX',
      corsConfig: 'https://a\\.example|https://b\\.example'
    }) as RegExp
    assert.ok(result instanceof RegExp)
    assert.equal(result.test('https://a.example'), true)
    assert.equal(result.test('https://b.example'), true)
    assert.equal(result.test('https://evil.test/?x=https://b.example'), false)
    assert.equal(result.test('https://b.example.attacker.test'), false)
    assert.equal(result.test('https://a.example.attacker.test'), false)
  })

  test('REGEX falls back to same-origin only on an invalid pattern', () => {
    assert.equal(corsOrigin({ corsMode: 'REGEX', corsConfig: '(' }), false)
  })
})

describe('corsOptions', () => {
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
  // -> Drives a real `@fastify/cors` registration through the preflight `OPTIONS` a browser sends
  //    before a cross-origin `PUT`/`DELETE`, rather than the options object asserted on above.
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
 * `@fastify/session`'s `onSend` refuses to emit a `Secure`-flagged cookie unless it saw the
 * connection itself as TLS (`request.protocol === 'https'`), which a proxy-less HTTP server never
 * is, loopback or not -- so a `Secure` pin means login silently sets no cookie at all. A
 * `__Host-`-prefixed cookie without `Secure` is in turn rejected by the browser, which is why
 * `security.cookieSecure: false` has to switch the name and not only the attribute.
 */
describe('sessionCookieName', () => {
  test('defaults to the hardened __Host- name when security.cookieSecure is unset', () => {
    ;(globalThis as any).CARDINAL.config.security = {}
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME)
  })

  test('stays hardened when security.cookieSecure is explicitly true', () => {
    ;(globalThis as any).CARDINAL.config.security = { cookieSecure: true }
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME)
  })

  test('drops the __Host- prefix when security.cookieSecure is false', () => {
    ;(globalThis as any).CARDINAL.config.security = { cookieSecure: false }
    assert.equal(sessionCookieName(), SESSION_COOKIE_NAME_INSECURE)
  })
})

/**
 * Proves the mechanism rather than the config toggle: a real `@fastify/session` registered with the
 * cookie options and `secure` wiring `index.ts` uses, driven over plain HTTP.
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

describe('frameAncestorsDirective', () => {
  test('an empty allowlist (the default) produces no directive', () => {
    assert.equal(frameAncestorsDirective([]), null)
  })

  test('always includes the self keyword alongside the configured origins', () => {
    assert.equal(
      frameAncestorsDirective(['https://tools.example.com']),
      "frame-ancestors 'self' https://tools.example.com"
    )
  })

  test('joins several origins with a single space', () => {
    assert.equal(
      frameAncestorsDirective(['https://a.example.com', 'https://b.example.com']),
      "frame-ancestors 'self' https://a.example.com https://b.example.com"
    )
  })
})

describe('appendCspDirective', () => {
  test('becomes the whole header value when nothing is set yet (CSP enforcement off instance-wide)', () => {
    assert.equal(appendCspDirective(undefined, "frame-ancestors 'self'"), "frame-ancestors 'self'")
  })

  test('appends onto an existing string header without disturbing it', () => {
    assert.equal(
      appendCspDirective("default-src 'self'", "frame-ancestors 'self' https://tools.example.com"),
      "default-src 'self'; frame-ancestors 'self' https://tools.example.com"
    )
  })

  test('joins an array header value (multiple setHeader calls coalesced) before appending', () => {
    assert.equal(
      appendCspDirective(["default-src 'self'", "script-src 'self'"], "frame-ancestors 'self'"),
      "default-src 'self'; script-src 'self'; frame-ancestors 'self'"
    )
  })
})
