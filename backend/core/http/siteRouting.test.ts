import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import Fastify from 'fastify'

import { resetAppShellCache } from '../../helpers/appShell.ts'
import {
  isPageUrl,
  isSpaAppRoute,
  registerAppShellFallback,
  registerSeoRedirects,
  RESERVED_ROOT_FILES,
  SERVER_ROUTE_SEGMENTS
} from './siteRouting.ts'
import { installTestWiki } from '../../test/mocks.ts'
import { makeGroupRule } from '../../test/builders.ts'

describe('isPageUrl', () => {
  test('a plain page path addresses the page tree', () => {
    assert.equal(isPageUrl('/home'), true)
    assert.equal(isPageUrl('/docs/getting-started'), true)
    assert.equal(isPageUrl('/'), true)
  })

  test('every server-owned first segment is excluded', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.equal(isPageUrl(`/${segment}/anything`), false, `${segment} should not be a page path`)
    }
  })

  test('every reserved root file is excluded, case-insensitively', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(isPageUrl(`/${file}`), false, `${file} should not be a page path`)
      assert.equal(isPageUrl(`/${file.toUpperCase()}`), false)
    }
  })

  test("the frontend router's own underscore routes are still not page paths", () => {
    // -> They reach the app shell through `registerAppShellFallback`. The prefix test cannot tell
    //    them apart from `/_api`, which is why `SERVER_ROUTE_SEGMENTS` is spelled out.
    assert.equal(isPageUrl('/_admin/general'), false)
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_admin'), false)
  })
})

describe('SERVER_ROUTE_SEGMENTS', () => {
  test('covers `/_api`, the one prefix every route file under api/ is mounted behind', () => {
    // -> A cheap floor rather than a full cross-check against `core/http/routes.ts`: with `/_api`
    //    dropped, an unmatched API path would answer with the app shell instead of a 404.
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_api'), true)
  })

  test('every entry is an underscore-prefixed single segment', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.match(segment, /^_[a-z]+$/, `${segment} should be one underscore-prefixed segment`)
    }
  })
})

describe('RESERVED_ROOT_FILES', () => {
  test('holds exactly the unprefixed root paths the server answers itself', () => {
    assert.deepEqual([...RESERVED_ROOT_FILES].sort(), [
      'favicon.ico',
      'metrics',
      'robots.txt',
      'sitemap.xml'
    ])
  })

  test('is stored lowercase, since isPageUrl lowercases before looking up', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(file, file.toLowerCase())
    }
  })
})

describe('isSpaAppRoute', () => {
  test('the login screen and its password-reset link are app routes', () => {
    assert.equal(isSpaAppRoute('/login'), true)
    assert.equal(isSpaAppRoute('/login/reset-password/abc123'), true)
    assert.equal(isSpaAppRoute('/login/other'), false)
  })

  test('`/a/:alias` is an app route, a bare `/a` or a deeper path is not', () => {
    assert.equal(isSpaAppRoute('/a/some-alias'), true)
    assert.equal(isSpaAppRoute('/a'), false)
    assert.equal(isSpaAppRoute('/a/some/alias'), false)
  })

  test('every underscore route the frontend router owns is an app route', () => {
    for (const urlPath of [
      '/_search',
      '/_tags',
      '/_graph',
      '/_admin',
      '/_admin/dashboard',
      '/_admin/site-1/general',
      '/_error',
      '/_error/notfound',
      '/_create',
      '/_create/markdown',
      '/_edit',
      '/_edit/docs/guide'
    ]) {
      assert.equal(isSpaAppRoute(urlPath), true, urlPath)
    }
  })

  test('an unknown underscore path, a page path and a junk path are not', () => {
    for (const urlPath of ['/_nope', '/_searchx', '/docs/guide', '/wp-login.php', '/', '/loginx']) {
      assert.equal(isSpaAppRoute(urlPath), false, urlPath)
    }
  })

  test('covers every top-level route declared in frontend/src/router/routes.js', async () => {
    const source = await readFile(
      path.join(import.meta.dirname, '../../../frontend/src/router/routes.js'),
      'utf8'
    )
    const routes = [...source.matchAll(/^ {4}path: '([^']+)'/gm)]
      .map((m) => m[1]!)
      .filter((route) => !route.includes('catchAll'))
    assert.ok(routes.length >= 8, `expected the router's top-level routes, found ${routes.length}`)
    const param = /:\w+(\([^)]*\))?/g
    for (const route of routes) {
      const withoutOptional = route.replace(/\/:\w+(\([^)]*\))?\?$/, '').replace(param, 'x')
      const withOptional = route.replace(/\?$/, '').replace(param, 'x')
      assert.equal(isSpaAppRoute(withoutOptional), true, `${route} -> ${withoutOptional}`)
      assert.equal(isSpaAppRoute(withOptional), true, `${route} -> ${withOptional}`)
    }
  })
})

describe('registerAppShellFallback', () => {
  const shellHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title></head>\n<body><div id="app"></div></body>\n</html>'
  let rootPath: string
  let previousCardinal: unknown
  let handler: (req: any, reply: any) => Promise<any>
  let pageRows: Array<Record<string, unknown>> = []
  let guestRules: unknown[] = []
  let lookupFails = false
  let lookups = 0

  function pageRow(overrides: Record<string, unknown> = {}) {
    return {
      locale: 'en',
      path: 'docs/guide',
      title: 'Guide',
      description: null,
      tags: [],
      classification: null,
      password: null,
      ...overrides
    }
  }

  before(async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), 'app-shell-'))
    await mkdir(path.join(rootPath, 'assets'))
    await writeFile(path.join(rootPath, 'assets/index.html'), shellHtml)
    previousCardinal = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      ROOTPATH: rootPath,
      sites: {},
      sitesMappings: {},
      data: { systemIds: { guestsGroupId: 'guests' } },
      db: {
        select: () => {
          const chain: any = {
            from: () => chain,
            where: () => {
              lookups++
              return lookupFails ? Promise.reject(new Error('db down')) : Promise.resolve(pageRows)
            }
          }
          return chain
        }
      },
      models: {
        locales: { getLocales: async () => [{ code: 'en', isRTL: false }] },
        groups: { rulesForGroups: () => guestRules }
      },
      logger: { error: () => {}, warn: () => {} }
    }
    resetAppShellCache()
    registerAppShellFallback({
      setNotFoundHandler: (fn: typeof handler) => {
        handler = fn
      }
    } as any)
  })

  after(async () => {
    ;(globalThis as any).CARDINAL = previousCardinal
    resetAppShellCache()
    await rm(rootPath, { recursive: true, force: true })
  })

  async function serve(method: string, url: string) {
    const sent: { body?: string; headers: Record<string, string>; type?: string; status: number } =
      {
        headers: {},
        status: 200
      }
    const reply: any = {
      code: (c: number) => {
        sent.status = c
        return reply
      },
      header: (k: string, v: string) => {
        sent.headers[k] = v
        return reply
      },
      type: (t: string) => {
        sent.type = t
        return reply
      },
      send: (b: string) => {
        sent.body = b
        return reply
      },
      notFound: () => {
        sent.body = 'not found'
        return reply
      }
    }
    await handler({ method, raw: { url }, hostname: 'wiki.test' }, reply)
    return sent
  }

  describe('status', () => {
    const plainShell = shellHtml.replace('<html lang="en">', '<html lang="en" dir="ltr">')

    beforeEach(() => {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = { '*': 'site-1' }
      cardinal.sites = { 'site-1': { config: { locales: { primary: 'en', active: ['en'] } } } }
      pageRows = []
      guestRules = [makeGroupRule({ match: 'START', path: '' })]
      lookupFails = false
      lookups = 0
    })

    after(() => {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = {}
      cardinal.sites = {}
      pageRows = []
      guestRules = []
    })

    test('a guest-readable page answers 200', async () => {
      pageRows = [pageRow()]
      const sent = await serve('GET', '/docs/guide')
      assert.equal(sent.status, 200)
      assert.equal(sent.body, plainShell)
    })

    test('a junk path answers 404 with the shell body', async () => {
      for (const url of ['/wp-login.php', '/no/such/page', '/_nope', '/a']) {
        const sent = await serve('GET', url)
        assert.equal(sent.status, 404, url)
        assert.equal(sent.body, plainShell, url)
      }
    })

    test('app routes answer 200 without looking for a page', async () => {
      for (const url of [
        '/login',
        '/login/reset-password/tok',
        '/a/alias',
        '/_admin/dashboard',
        '/_search',
        '/_tags',
        '/_graph',
        '/_error/notfound',
        '/_create/markdown',
        '/_edit/docs/guide'
      ]) {
        const sent = await serve('GET', url)
        assert.equal(sent.status, 200, url)
      }
      assert.equal(lookups, 0)
    })

    test('an underscore path skips the page lookup', async () => {
      await serve('GET', '/_nope')
      assert.equal(lookups, 0)
    })

    test('HEAD answers the status GET would', async () => {
      pageRows = [pageRow()]
      assert.equal((await serve('HEAD', '/docs/guide')).status, 200)
      pageRows = []
      assert.equal((await serve('HEAD', '/docs/guide')).status, 404)
    })

    test('a guest-unreadable page and a missing page are indistinguishable', async () => {
      pageRows = [pageRow({ path: 'hr/salaries' })]
      guestRules = [
        makeGroupRule({ match: 'START', path: '' }),
        makeGroupRule({ id: 'deny', match: 'START', path: 'hr', mode: 'DENY' })
      ]
      const denied = await serve('GET', '/hr/salaries')
      pageRows = []
      const missing = await serve('GET', '/hr/salaries')
      assert.equal(denied.status, 404)
      assert.deepEqual(denied, missing)
    })

    test('a password-locked page answers 404, the same as a missing one', async () => {
      pageRows = [pageRow({ password: '$2a$hash' })]
      const locked = await serve('GET', '/docs/guide')
      pageRows = []
      const missing = await serve('GET', '/docs/guide')
      assert.equal(locked.status, 404)
      assert.deepEqual(locked, missing)
    })

    test('a request that resolves to no site answers 404', async () => {
      ;(globalThis as any).CARDINAL.sitesMappings = {}
      assert.equal((await serve('GET', '/docs/guide')).status, 404)
      assert.equal((await serve('GET', '/login')).status, 200)
    })

    test('a failed lookup answers 200 rather than declaring the page missing', async () => {
      lookupFails = true
      const sent = await serve('GET', '/docs/guide')
      assert.equal(sent.status, 200)
      assert.equal(sent.body, plainShell)
    })

    test('a non-read method and a server-owned segment answer as a plain not-found', async () => {
      assert.equal((await serve('POST', '/docs/guide')).body, 'not found')
      assert.equal((await serve('GET', '/_api/nope')).body, 'not found')
    })
  })

  test('with no fragments the served shell is the templated shell, byte for byte', async () => {
    const sent = await serve('GET', '/guides/x')
    assert.equal(sent.body, shellHtml.replace('<html lang="en">', '<html lang="en" dir="ltr">'))
    assert.equal(sent.headers['Cache-Control'], 'no-store')
    assert.equal(sent.type, 'text/html; charset=utf-8')
  })

  describe('theme injection', () => {
    function setSite(theme: Record<string, unknown> | undefined) {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = { '*': 'site-1' }
      cardinal.sites = { 'site-1': { config: { theme } } }
    }

    after(() => {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = {}
      cardinal.sites = {}
    })

    test('a raw fetch carries the site head, CSS and body markup exactly once', async () => {
      setSite({
        injectCSS: 'body { color: red }',
        injectHead: '<meta name="site-verification" content="abc">',
        injectBody: '<script src="/beacon.js"></script>'
      })
      const { body } = await serve('GET', '/guides/x')
      const count = (needle: string) => body!.split(needle).length - 1
      assert.equal(count('<style id="theme-inject-css">body { color: red }</style>'), 1)
      assert.equal(count('<meta name="site-verification" content="abc">'), 1)
      assert.equal(count('<script src="/beacon.js"></script>'), 1)
      assert.ok(body!.indexOf('site-verification') < body!.indexOf('</head>'))
      assert.ok(body!.indexOf('beacon.js') > body!.indexOf('<div id="app">'))
      assert.ok(body!.indexOf('beacon.js') < body!.indexOf('</body>'))
    })

    test('a path no page owns (the not-found fallback) is injected the same way', async () => {
      setSite({ injectHead: '<meta name="x" content="y">' })
      const { body } = await serve('GET', '/no/such/page')
      assert.equal(body!.split('<meta name="x" content="y">').length - 1, 1)
    })

    test('fragments containing replacement patterns or closing tags land intact', async () => {
      setSite({ injectHead: '<i>$& $1 </body></i>', injectBody: '<b>$`</b>' })
      const { body } = await serve('GET', '/a')
      assert.ok(body!.includes('<i>$& $1 </body></i></head>'))
      assert.ok(body!.includes('<b>$`</b></body>'))
    })

    test('a site with empty injection fields is served the plain shell', async () => {
      setSite({ injectCSS: '', injectHead: '', injectBody: '' })
      const { body } = await serve('GET', '/a')
      assert.equal(body, shellHtml.replace('<html lang="en">', '<html lang="en" dir="ltr">'))
    })

    test('an unresolved site is served the plain shell', async () => {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = {}
      const { body } = await serve('GET', '/a')
      assert.equal(body, shellHtml.replace('<html lang="en">', '<html lang="en" dir="ltr">'))
    })
  })

  test('repeated requests keep serving the same bytes', async () => {
    const first = await serve('GET', '/a')
    const second = await serve('HEAD', '/b?x=1')
    assert.equal(second.body, first.body)
  })
})

describe('registerSeoRedirects locale aliases', () => {
  async function redirectFor(url: string, locales: Record<string, unknown>) {
    const handle = installTestWiki({
      sitesMappings: { '*': 'site-1' },
      sites: { 'site-1': { config: { locales } } }
    })
    const app = Fastify()
    registerSeoRedirects(app)
    app.get('/*', async () => 'ok')
    try {
      const res = await app.inject({ method: 'GET', url })
      return { status: res.statusCode, location: res.headers.location }
    } finally {
      await app.close()
      handle.restore()
    }
  }

  const base = { primary: 'en', active: ['en', 'zh-CN'], forcePrefix: false }
  const aliased = { ...base, aliases: { 'zh-CN': 'zh' } }

  test('302s the canonical spelling to the alias and keeps the query string', async () => {
    assert.deepEqual(await redirectFor('/zh-CN/page?a=1', aliased), {
      status: 302,
      location: '/zh/page?a=1'
    })
  })

  test('leaves the alias spelling alone', async () => {
    assert.deepEqual(await redirectFor('/zh/page', aliased), { status: 200, location: undefined })
  })

  test('re-cases a mis-cased alias', async () => {
    assert.deepEqual(await redirectFor('/ZH/page', aliased), {
      status: 302,
      location: '/zh/page'
    })
  })

  test('forcePrefix sends a bare path to the primary locale alias, then settles', async () => {
    const cfg = { ...aliased, forcePrefix: true, aliases: { en: 'e', 'zh-CN': 'zh' } }
    assert.deepEqual(await redirectFor('/page', cfg), { status: 302, location: '/e/page' })
    assert.deepEqual(await redirectFor('/e/page', cfg), { status: 200, location: undefined })
    assert.deepEqual(await redirectFor('/en/page', cfg), { status: 302, location: '/e/page' })
  })

  test('without aliases the canonical spelling is untouched', async () => {
    assert.deepEqual(await redirectFor('/zh-CN/page', base), { status: 200, location: undefined })
  })
})
