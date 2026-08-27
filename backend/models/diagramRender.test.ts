import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, mock, test, describe } from 'node:test'
import type { ExtensionDefinition } from './extensions.ts'

const PUPPETEER_DEFINITION: ExtensionDefinition = {
  key: 'puppeteer',
  title: 'Puppeteer',
  description: 'Headless Chromium browser.',
  detect: { type: 'module', value: 'puppeteer' },
  isInstallable: true
}

/**
 * `mountBlockElementScript` runs inside a headless browser via `page.evaluate`, so it can only ever
 * touch `document` off `globalThis` — exactly what is stubbed here, standing in for the page's own DOM
 * without needing a real browser. `importBlockScript`'s single `import()` line is not tested directly:
 * a dynamic import of a network specifier is meaningless outside a real browser page, the same reason
 * `pdfExport.test.ts` never exercises a real `page.goto` either — see `DiagramRender.render`'s tests
 * below for what IS checked about it (that it is called with the right URL).
 */
describe('mountBlockElementScript', () => {
  let created: any[]
  let body: any

  beforeEach(() => {
    created = []
    body = { appendChild: mock.fn() }
    ;(globalThis as any).document = {
      createElement: (tagName: string) => {
        const el: any = {
          tagName,
          attributes: {} as Record<string, string>,
          children: [] as any[],
          setAttribute(key: string, value: string) {
            this.attributes[key] = value
          },
          appendChild(child: any) {
            this.children.push(child)
          },
          set textContent(value: string) {
            this._text = value
          },
          get textContent() {
            return this._text
          }
        }
        created.push(el)
        return el
      },
      body
    }
  })

  after(() => {
    delete (globalThis as any).document
  })

  test('creates the block element, sets every attr, appends a <pre> carrying the source, and mounts it', async () => {
    const { mountBlockElementScript } = await import('./diagramRender.ts')

    mountBlockElementScript('block-diagram', { theme: 'dark' }, 'flowchart LR\nA --> B')

    const [el, pre] = created
    assert.equal(el.tagName, 'block-diagram')
    assert.deepEqual(el.attributes, { theme: 'dark' })
    assert.equal(pre.tagName, 'pre')
    assert.equal(pre.textContent, 'flowchart LR\nA --> B')
    assert.deepEqual(el.children, [pre])
    assert.deepEqual(body.appendChild.mock.calls[0].arguments, [el])
  })

  test('sets no attribute at all when attrs is empty', async () => {
    const { mountBlockElementScript } = await import('./diagramRender.ts')

    mountBlockElementScript('block-plantuml', {}, '@startuml\nA -> B\n@enduml')

    assert.deepEqual(created[0].attributes, {})
  })
})

/**
 * `extractDiagramScript` runs inside a headless browser via `page.evaluate`, reading back a mounted
 * block's shadow root — stubbed here the same way `mountBlockElementScript`'s tests stub `document`.
 */
describe('extractDiagramScript', () => {
  after(() => {
    delete (globalThis as any).document
  })

  function stubShadowRoot(shadowRoot: any) {
    ;(globalThis as any).document = {
      querySelector: (selector: string) => {
        assert.equal(selector, 'block-diagram')
        return { shadowRoot }
      }
    }
  }

  test('returns the drawn SVG when the block settled cleanly', async () => {
    const { extractDiagramScript } = await import('./diagramRender.ts')
    stubShadowRoot({
      querySelector: (selector: string) => {
        if (selector === '.error') return null
        if (selector === 'svg') return { outerHTML: '<svg>diagram</svg>' }
        throw new Error(`Unexpected selector: ${selector}`)
      }
    })

    const result = await extractDiagramScript('block-diagram')

    assert.deepEqual(result, { svg: '<svg>diagram</svg>', error: null })
  })

  test("returns the block's own error panel text when it could not draw", async () => {
    const { extractDiagramScript } = await import('./diagramRender.ts')
    stubShadowRoot({
      querySelector: (selector: string) => {
        if (selector === '.error')
          return { textContent: 'This diagram could not be drawn: bad syntax' }
        throw new Error(`Unexpected selector: ${selector}`)
      }
    })

    const result = await extractDiagramScript('block-diagram')

    assert.deepEqual(result, { svg: null, error: 'This diagram could not be drawn: bad syntax' })
  })

  test('reports no drawing when neither an SVG nor an error panel is there yet', async () => {
    const { extractDiagramScript } = await import('./diagramRender.ts')
    stubShadowRoot({
      querySelector: (selector: string) => {
        if (selector === '.error') return null
        if (selector === 'svg') return null
        throw new Error(`Unexpected selector: ${selector}`)
      }
    })

    const result = await extractDiagramScript('block-diagram')

    assert.deepEqual(result, { svg: null, error: 'This diagram produced no drawing.' })
  })
})

/**
 * `DiagramRender.render` orchestrates both paths end to end. The Mermaid path's `launchBrowser` is
 * mocked the same way `pdfExport.test.ts` mocks its own, so the business logic (the settle wait, the
 * script URL, the timeout guards, closing the browser whether or not the render succeeded) is verified
 * without a real Puppeteer install. The PlantUML path mocks `globalThis.fetch` instead, since it never
 * touches a browser at all — see the model's own class comment for why.
 */
describe('DiagramRender.render', () => {
  let isInstalled: ReturnType<typeof mock.fn>
  let diagramRender: typeof import('./diagramRender.ts').diagramRender
  let importBlockScript: typeof import('./diagramRender.ts').importBlockScript
  let mountBlockElementScript: typeof import('./diagramRender.ts').mountBlockElementScript
  let blockSettleScript: typeof import('./pdfExport.ts').blockSettleScript
  let extractDiagramScript: typeof import('./diagramRender.ts').extractDiagramScript

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { port: 3000 },
      logger: { debug: () => {} },
      models: {
        extensions: {
          getDefinition: mock.fn((key: string) =>
            key === 'puppeteer' ? PUPPETEER_DEFINITION : null
          ),
          isInstalled: mock.fn(async () => true)
        }
      }
    }
    ;({ diagramRender, importBlockScript, mountBlockElementScript, extractDiagramScript } =
      await import('./diagramRender.ts'))
    ;({ blockSettleScript } = await import('./pdfExport.ts'))
    isInstalled = (globalThis as any).WIKI.models.extensions.isInstalled
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  function fakeBrowser(extractResult: { svg: string | null; error: string | null }) {
    calls = {
      setContent: [] as any[],
      evaluate: [] as any[],
      screenshot: [] as any[],
      closed: false
    }
    const page = {
      setContent: async (...args: any[]) => calls.setContent.push(args),
      evaluate: async (fn: any, ...args: any[]) => {
        calls.evaluate.push({ fn, args })
        if (fn === extractDiagramScript) {
          return extractResult
        }
        return undefined
      },
      $: async (selector: string) => {
        calls.evaluate.push({ selector })
        return {
          screenshot: async (...args: any[]) => {
            calls.screenshot.push(args)
            return Buffer.from('PNGDATA')
          }
        }
      }
    }
    return {
      newPage: async () => page,
      close: async () => {
        calls.closed = true
      }
    }
  }

  let calls: any

  beforeEach(() => {
    isInstalled.mock.resetCalls()
    isInstalled.mock.mockImplementation(async () => true)
    ;(globalThis as any).fetch = undefined
  })

  test('refuses an empty source before doing anything else', async () => {
    await assert.rejects(diagramRender.render({ type: 'mermaid', source: '   ' }), (err: any) => {
      assert.equal(err.name, 'diagramRenderEmpty')
      assert.equal(err.statusCode, 400)
      return true
    })
  })

  test('refuses an unsupported diagram type', async () => {
    await assert.rejects(
      diagramRender.render({ type: 'graphviz' as any, source: 'digraph {}' }),
      (err: any) => {
        assert.equal(err.name, 'diagramRenderUnsupportedType')
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  describe('mermaid', () => {
    test('refuses when Puppeteer is not installed', async () => {
      isInstalled.mock.mockImplementation(async () => false)

      await assert.rejects(
        diagramRender.render({ type: 'mermaid', source: 'flowchart LR\nA --> B' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderPuppeteerMissing')
          assert.equal(err.statusCode, 503)
          return true
        }
      )
    })

    test('refuses a source past the server-side length limit without opening a browser', async () => {
      await assert.rejects(
        diagramRender.render({ type: 'mermaid', source: 'A'.repeat(20001) }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderTooLarge')
          assert.equal(err.statusCode, 413)
          return true
        }
      )
    })

    test("mounts block-diagram from this instance's own /_blocks bundle, settles it, and returns the SVG", async () => {
      const browser = fakeBrowser({ svg: '<svg>diagram</svg>', error: null })
      const launchBrowser = mock.method(diagramRender as any, 'launchBrowser', async () => browser)

      try {
        const result = await diagramRender.render({
          type: 'mermaid',
          source: 'flowchart LR\nA --> B',
          theme: 'dark'
        })

        assert.equal(result.contentType, 'image/svg+xml')
        assert.equal(result.data.toString('utf8'), '<svg>diagram</svg>')

        assert.equal(calls.setContent[0][0], '<!doctype html><html><body></body></html>')

        const importCall = calls.evaluate.find((c: any) => c.fn === importBlockScript)
        assert.deepEqual(importCall.args, ['http://127.0.0.1:3000/_blocks/block-diagram.js'])

        const mountCall = calls.evaluate.find((c: any) => c.fn === mountBlockElementScript)
        assert.deepEqual(mountCall.args, [
          'block-diagram',
          { theme: 'dark' },
          'flowchart LR\nA --> B'
        ])

        const settleCall = calls.evaluate.find((c: any) => c.fn === blockSettleScript)
        assert.deepEqual(settleCall.args, [20])

        assert.equal(calls.closed, true)
      } finally {
        launchBrowser.mock.restore()
      }
    })

    test('falls back an unrecognized theme (including "auto") to "default"', async () => {
      const browser = fakeBrowser({ svg: '<svg/>', error: null })
      const launchBrowser = mock.method(diagramRender as any, 'launchBrowser', async () => browser)

      try {
        await diagramRender.render({
          type: 'mermaid',
          source: 'flowchart LR\nA --> B',
          theme: 'auto'
        })

        const mountCall = calls.evaluate.find((c: any) => c.fn === mountBlockElementScript)
        assert.deepEqual(mountCall.args[1], { theme: 'default' })
      } finally {
        launchBrowser.mock.restore()
      }
    })

    test("surfaces the block's own error message and still closes the browser", async () => {
      const browser = fakeBrowser({
        svg: null,
        error: 'This diagram could not be drawn: bad syntax'
      })
      const launchBrowser = mock.method(diagramRender as any, 'launchBrowser', async () => browser)

      try {
        await assert.rejects(
          diagramRender.render({ type: 'mermaid', source: 'not a diagram' }),
          (err: any) => {
            assert.equal(err.name, 'diagramRenderFailed')
            assert.equal(err.statusCode, 422)
            assert.match(err.message, /bad syntax/)
            return true
          }
        )
        assert.equal(calls.closed, true)
      } finally {
        launchBrowser.mock.restore()
      }
    })

    test('screenshots the mounted element for a png request instead of returning the SVG text', async () => {
      const browser = fakeBrowser({ svg: '<svg>diagram</svg>', error: null })
      const launchBrowser = mock.method(diagramRender as any, 'launchBrowser', async () => browser)

      try {
        const result = await diagramRender.render({
          type: 'mermaid',
          source: 'flowchart LR\nA --> B',
          format: 'png'
        })

        assert.equal(result.contentType, 'image/png')
        assert.equal(result.data.toString('utf8'), 'PNGDATA')
        assert.equal(calls.screenshot.length, 1)
      } finally {
        launchBrowser.mock.restore()
      }
    })

    test('closes the browser even when the render fails partway through', async () => {
      const browser = fakeBrowser({ svg: null, error: null })
      ;(await browser.newPage()).setContent = async () => {
        throw new Error('boom')
      }
      const launchBrowser = mock.method(diagramRender as any, 'launchBrowser', async () => browser)

      try {
        await assert.rejects(
          diagramRender.render({ type: 'mermaid', source: 'flowchart LR\nA --> B' })
        )
        assert.equal(calls.closed, true)
      } finally {
        launchBrowser.mock.restore()
      }
    })
  })

  describe('plantuml', () => {
    test('never checks Puppeteer availability', async () => {
      ;(globalThis as any).fetch = mock.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/svg+xml' }
          })
      )

      await diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' })

      assert.equal(isInstalled.mock.callCount(), 0)
    })

    test('fetches the same deflate-encoded URL block-plantuml would set as its <img src>', async () => {
      const fetchMock = mock.fn(
        async (_url: string) => new Response(new Uint8Array([9, 9, 9]), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      const result = await diagramRender.render({
        type: 'plantuml',
        source: '@startuml\nAlice -> Bob : hello\n@enduml'
      })

      assert.equal(fetchMock.mock.callCount(), 1)
      const url = fetchMock.mock.calls[0].arguments[0] as string
      assert.match(url, /^https:\/\/www\.plantuml\.com\/plantuml\/svg\/[0-9A-Za-z_-]+$/)
      assert.equal(result.contentType, 'image/svg+xml')
      assert.equal(result.data.toString('hex'), '090909')
    })

    test('renders the png format against the fixed default server', async () => {
      const fetchMock = mock.fn(
        async (_url: string) => new Response(new Uint8Array([1]), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramRender.render({
        type: 'plantuml',
        source: '@startuml\nA -> B\n@enduml',
        format: 'png'
      })

      const url = fetchMock.mock.calls[0].arguments[0] as string
      assert.match(url, /^https:\/\/www\.plantuml\.com\/plantuml\/png\//)
    })

    test('a server field on the request cannot change the fetched URL or reach the model at all (OpenProject #2219)', async () => {
      const fetchMock = mock.fn(
        async (_url: string) => new Response(new Uint8Array([1]), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramRender.render({
        type: 'plantuml',
        source: '@startuml\nA -> B\n@enduml',
        // @ts-expect-error -- `server` no longer exists on `DiagramRenderRequest`; a caller that
        // still sends it (an un-upgraded client, or a request forged past the API schema) must be
        // silently ignored, not honored.
        server: 'https://attacker.example.com/steal'
      })

      assert.equal(fetchMock.mock.callCount(), 1)
      const url = fetchMock.mock.calls[0].arguments[0] as string
      assert.match(url, /^https:\/\/www\.plantuml\.com\/plantuml\/svg\//)
      assert.doesNotMatch(url, /attacker\.example\.com/)
    })

    test('fetches with `redirect: error` and a bounded timeout signal, matching LiveData#resolve (OpenProject #2216)', async () => {
      const fetchMock = mock.fn(
        async (_url: string, _options?: RequestInit) =>
          new Response(new Uint8Array([1]), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' })

      assert.equal(fetchMock.mock.callCount(), 1)
      const options = fetchMock.mock.calls[0].arguments[1] as RequestInit
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
    })

    test('reports a redirect refusal as the same clean failure a network error gets', async () => {
      ;(globalThis as any).fetch = mock.fn(async () => {
        throw new TypeError('fetch failed: unexpected redirect')
      })

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 502)
          assert.match(err.message, /unexpected redirect/)
          return true
        }
      )
    })

    test('fetches with redirect: "error" and a bounded abort signal (OpenProject #2226)', async () => {
      const fetchMock = mock.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(new Uint8Array([1]), { status: 200 })
      )
      ;(globalThis as any).fetch = fetchMock

      await diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' })

      const init = fetchMock.mock.calls[0].arguments[1]
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
    })

    test('reports a redirecting server as a clean error rather than following it (OpenProject #2226)', async () => {
      ;(globalThis as any).fetch = mock.fn(async (_url: string, init: RequestInit) => {
        if (init.redirect === 'error') {
          // -> What undici actually throws for a redirect response under `redirect: 'error'`.
          throw new TypeError('fetch failed')
        }
        throw new Error('should never fetch without redirect: "error"')
      })

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })

    test('reports a hanging server as a clean error rather than an indefinite hang (OpenProject #2226)', async () => {
      ;(globalThis as any).fetch = mock.fn(async () => {
        // -> What undici actually throws once `AbortSignal.timeout` fires mid-request.
        throw new DOMException('The operation was aborted.', 'TimeoutError')
      })

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 502)
          assert.match(err.message, /aborted/i)
          return true
        }
      )
    })

    test('surfaces the X-PlantUML-Diagram-Error header as the failure reason', async () => {
      ;(globalThis as any).fetch = mock.fn(
        async () =>
          new Response(new Uint8Array(), {
            status: 200,
            headers: { 'x-plantuml-diagram-error': 'Syntax error on line 2' }
          })
      )

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nbroken\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 422)
          assert.match(err.message, /Syntax error on line 2/)
          return true
        }
      )
    })

    test('reports a non-ok response as a server failure', async () => {
      ;(globalThis as any).fetch = mock.fn(
        async () => new Response(new Uint8Array(), { status: 502, statusText: 'Bad Gateway' })
      )

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 502)
          return true
        }
      )
    })

    test('reports an unreachable server rather than throwing the raw network error', async () => {
      ;(globalThis as any).fetch = mock.fn(async () => {
        throw new Error('ECONNREFUSED')
      })

      await assert.rejects(
        diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
        (err: any) => {
          assert.equal(err.name, 'diagramRenderFailed')
          assert.equal(err.statusCode, 502)
          assert.match(err.message, /ECONNREFUSED/)
          return true
        }
      )
    })

    test('refuses a diagram whose encoded URL would be too large for a GET request, before ever fetching', async () => {
      const fetchMock = mock.fn(async () => new Response(new Uint8Array(), { status: 200 }))
      ;(globalThis as any).fetch = fetchMock

      // -> Deflate compresses repetition extremely well, so the source has to be genuinely
      //    high-entropy (not just long) to actually produce an over-the-limit encoded URL
      const source = randomBytes(8000).toString('hex')
      await assert.rejects(diagramRender.render({ type: 'plantuml', source }), (err: any) => {
        assert.equal(err.name, 'diagramRenderTooLarge')
        assert.equal(err.statusCode, 413)
        return true
      })
      assert.equal(fetchMock.mock.callCount(), 0)
    })

    test('refuses to reach a PlantUML server at all when the instance is in offline mode (OpenProject #820)', async () => {
      const fetchMock = mock.fn(async () => new Response(new Uint8Array(), { status: 200 }))
      ;(globalThis as any).fetch = fetchMock
      ;(globalThis as any).WIKI.config.offline = true

      try {
        await assert.rejects(
          diagramRender.render({ type: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
          (err: any) => {
            assert.equal(err.name, 'diagramRenderOffline')
            assert.equal(err.statusCode, 503)
            return true
          }
        )
        assert.equal(fetchMock.mock.callCount(), 0)
      } finally {
        ;(globalThis as any).WIKI.config.offline = false
      }
    })
  })
})
