import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import Fastify from 'fastify'

import { resetAppShellCache } from '../../helpers/appShell.ts'
import {
  isPageUrl,
  registerAppShellFallback,
  registerSeoRedirects,
  RESERVED_ROOT_FILES,
  SERVER_ROUTE_SEGMENTS
} from './siteRouting.ts'
import { installTestWiki } from '../../test/mocks.ts'

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

describe('registerAppShellFallback', () => {
  const shellHtml =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title></head>\n<body><div id="app"></div></body>\n</html>'
  let rootPath: string
  let previousCardinal: unknown
  let handler: (req: any, reply: any) => Promise<any>

  before(async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), 'app-shell-'))
    await mkdir(path.join(rootPath, 'assets'))
    await writeFile(path.join(rootPath, 'assets/index.html'), shellHtml)
    previousCardinal = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      ROOTPATH: rootPath,
      sites: {},
      sitesMappings: {},
      models: { locales: { getLocales: async () => [{ code: 'en', isRTL: false }] } },
      logger: { error: () => {} }
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
    const sent: { body?: string; headers: Record<string, string>; type?: string } = { headers: {} }
    const reply: any = {
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

  describe('robots', () => {
    function setRobots(config: Record<string, unknown>) {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = { '*': 'site-1' }
      cardinal.sites = { 'site-1': { config } }
    }

    after(() => {
      const cardinal = (globalThis as any).CARDINAL
      cardinal.sitesMappings = {}
      cardinal.sites = {}
    })

    const cases: Array<[boolean, boolean, string]> = [
      [true, true, 'index, follow'],
      [false, true, 'noindex, follow'],
      [true, false, 'index, nofollow'],
      [false, false, 'noindex, nofollow']
    ]
    for (const [index, follow, directive] of cases) {
      test(`index=${index} follow=${follow} sends "${directive}" as header and meta`, async () => {
        setRobots({ robots: { index, follow } })
        const sent = await serve('GET', '/guides/x')
        assert.equal(sent.headers['X-Robots-Tag'], directive)
        const meta = `<meta name="robots" content="${directive}">`
        assert.equal(sent.body!.split(meta).length - 1, 1)
        assert.ok(sent.body!.indexOf(meta) < sent.body!.indexOf('</head>'))
      })
    }

    test('a HEAD request and a not-found path carry the same header', async () => {
      setRobots({ robots: { index: false, follow: false } })
      const head = await serve('HEAD', '/no/such/page')
      assert.equal(head.headers['X-Robots-Tag'], 'noindex, nofollow')
    })

    test('robots and theme injection share the one head', async () => {
      setRobots({ robots: { index: false, follow: true }, theme: { injectHead: '<i>t</i>' } })
      const { body } = await serve('GET', '/a')
      assert.ok(body!.includes('<meta name="robots" content="noindex, follow"><i>t</i></head>'))
    })

    test('a site with no robots block gets neither header nor meta', async () => {
      setRobots({})
      const sent = await serve('GET', '/a')
      assert.equal(sent.headers['X-Robots-Tag'], undefined)
      assert.equal(sent.body!.includes('name="robots"'), false)
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
