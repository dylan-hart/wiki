import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'

/**
 * `DiagramProxy.render` never touches a browser (unlike `DiagramRender`'s Mermaid path) — both
 * engines are a plain outbound `fetch`, so every test here mocks `globalThis.fetch` directly, the
 * same way `diagramRender.test.ts` does for its own PlantUML path.
 */
describe('DiagramProxy.render', () => {
  let getSiteBlocks: ReturnType<typeof mock.fn>
  let diagramProxy: typeof import('./diagramProxy.ts').diagramProxy

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { offline: false },
      models: {
        blocks: {
          getSiteBlocks: mock.fn(async (_siteId: string) => [] as any[])
        }
      }
    }
    ;({ diagramProxy } = await import('./diagramProxy.ts'))
    getSiteBlocks = (globalThis as any).WIKI.models.blocks.getSiteBlocks
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getSiteBlocks.mock.resetCalls()
    getSiteBlocks.mock.mockImplementation(async () => [])
    ;(globalThis as any).WIKI.config.offline = false
    ;(globalThis as any).fetch = undefined
  })

  test('refuses an empty source before doing anything else', async () => {
    await assert.rejects(
      diagramProxy.render('site-1', { engine: 'kroki', source: '   ', diagramType: 'graphviz' }),
      (err: any) => {
        assert.equal(err.name, 'diagramProxyEmpty')
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('refuses a source over the character limit', async () => {
    const huge = 'x'.repeat(200_001)
    await assert.rejects(
      diagramProxy.render('site-1', { engine: 'plantuml', source: huge }),
      (err: any) => {
        assert.equal(err.name, 'diagramProxyTooLarge')
        assert.equal(err.statusCode, 413)
        return true
      }
    )
  })

  test('refuses when the instance is in offline mode', async () => {
    ;(globalThis as any).WIKI.config.offline = true
    await assert.rejects(
      diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
      (err: any) => {
        assert.equal(err.name, 'diagramProxyOffline')
        assert.equal(err.statusCode, 503)
        return true
      }
    )
  })

  test('refuses an unsupported engine', async () => {
    await assert.rejects(
      diagramProxy.render('site-1', { engine: 'mermaid' as any, source: 'flowchart LR\nA --> B' }),
      (err: any) => {
        assert.equal(err.name, 'diagramProxyUnsupportedEngine')
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  describe('kroki', () => {
    test('refuses a request with no diagramType', async () => {
      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'kroki', source: 'digraph G { A -> B }' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyMissingType')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })

    test("POSTs Kroki's JSON contract to the public default server", async () => {
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) =>
          new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } })
      )
      ;(globalThis as any).fetch = fetchMock

      const result = await diagramProxy.render('site-1', {
        engine: 'kroki',
        source: 'digraph G { A -> B }',
        diagramType: 'graphviz'
      })

      assert.equal(fetchMock.mock.callCount(), 1)
      const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
      assert.equal(url, 'https://kroki.io/')
      assert.equal(init.method, 'POST')
      assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(init.body as string), {
        diagram_source: 'digraph G { A -> B }',
        diagram_type: 'graphviz',
        output_format: 'svg'
      })
      assert.equal(result.contentType, 'image/svg+xml')
      assert.equal(result.data.toString(), '<svg/>')
    })

    test('renders against a site-configured server, trimmed of trailing slashes, and the png format', async () => {
      getSiteBlocks.mock.mockImplementation(async () => [
        { block: 'kroki', config: { server: 'https://kroki.example.com///' } }
      ])
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(Buffer.from('PNGDATA'), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramProxy.render('site-1', {
        engine: 'kroki',
        source: 'digraph G { A -> B }',
        diagramType: 'graphviz',
        format: 'png'
      })

      const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
      assert.equal(url, 'https://kroki.example.com/')
      assert.equal(JSON.parse(init.body as string).output_format, 'png')
    })

    test('a request-supplied server is never read — only the site config is', async () => {
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) => new Response('<svg/>', { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramProxy.render('site-1', {
        engine: 'kroki',
        source: 'digraph G { A -> B }',
        diagramType: 'graphviz',
        // @ts-expect-error -- not part of DiagramProxyRequest; proves an extra field can't steer it
        server: 'https://attacker.example.com'
      })

      const [url] = fetchMock.mock.calls[0].arguments
      assert.equal(url, 'https://kroki.io/')
    })
  })

  describe('plantuml', () => {
    test("POSTs the raw source as text to the server's own /{format}/ path", async () => {
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) => new Response('<svg/>', { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      const result = await diagramProxy.render('site-1', {
        engine: 'plantuml',
        source: '@startuml\nA -> B\n@enduml'
      })

      assert.equal(fetchMock.mock.callCount(), 1)
      const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
      assert.equal(url, 'https://www.plantuml.com/plantuml/svg/')
      assert.equal(init.method, 'POST')
      assert.equal(
        (init.headers as Record<string, string>)['Content-Type'],
        'text/plain; charset=utf-8'
      )
      assert.equal(init.body, '@startuml\nA -> B\n@enduml')
      assert.equal(result.contentType, 'image/svg+xml')
    })

    test('renders against a site-configured server, trimmed of trailing slashes, png included', async () => {
      getSiteBlocks.mock.mockImplementation(async () => [
        { block: 'plantuml', config: { server: 'https://plantuml.example.com/plantuml///' } }
      ])
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(Buffer.from('PNGDATA'), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramProxy.render('site-1', {
        engine: 'plantuml',
        source: '@startuml\nA -> B\n@enduml',
        format: 'png'
      })

      const [url] = fetchMock.mock.calls[0].arguments
      assert.equal(url, 'https://plantuml.example.com/plantuml/png/')
    })

    test('surfaces the x-plantuml-diagram-error header, even on a 200', async () => {
      const fetchMock = mock.fn(
        async () =>
          new Response('<svg/>', {
            status: 200,
            headers: { 'x-plantuml-diagram-error': 'Syntax error' }
          })
      )
      ;(globalThis as any).fetch = fetchMock

      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nbroken' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyFailed')
          assert.match(err.message, /Syntax error/)
          assert.equal(err.statusCode, 422)
          return true
        }
      )
    })

    test('a non-ok response with no reason header answers with the status line', async () => {
      const fetchMock = mock.fn(
        async () => new Response('nope', { status: 500, statusText: 'Internal Server Error' })
      )
      ;(globalThis as any).fetch = fetchMock

      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyFailed')
          assert.match(err.message, /500/)
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })

    test('fetches with redirect: "error" and a bounded abort signal', async () => {
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) => new Response('<svg/>', { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramProxy.render('site-1', {
        engine: 'plantuml',
        source: '@startuml\nA -> B\n@enduml'
      })

      const init = fetchMock.mock.calls[0].arguments[1]
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
    })

    test('a network failure answers 502, not a raw throw', async () => {
      ;(globalThis as any).fetch = mock.fn(async () => {
        throw new TypeError('fetch failed')
      })

      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyUnreachable')
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })
  })

  describe('response size guard', () => {
    test('refuses a response whose Content-Length exceeds the cap without reading the body', async () => {
      const fetchMock = mock.fn(
        async () =>
          new Response('<svg/>', {
            status: 200,
            headers: { 'Content-Length': String(10_000_001) }
          })
      )
      ;(globalThis as any).fetch = fetchMock

      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyResponseTooLarge')
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })

    test('refuses a streamed response that grows past the cap with no truthful Content-Length', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          // -> One 1 MB chunk at a time, well past the 10 MB cap after eleven pulls, with no
          //    `Content-Length` header at all -- the case a header-only check would miss.
          controller.enqueue(new Uint8Array(1_000_000))
        }
      })
      const fetchMock = mock.fn(async () => new Response(stream, { status: 200 }))
      ;(globalThis as any).fetch = fetchMock

      await assert.rejects(
        diagramProxy.render('site-1', { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramProxyResponseTooLarge')
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })
  })
})
