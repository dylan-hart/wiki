import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { ExtensionDefinition } from './extensions.ts'

const PUPPETEER_DEFINITION: ExtensionDefinition = {
  key: 'puppeteer',
  title: 'Puppeteer',
  description: 'Headless Chromium browser.',
  detect: { type: 'module', value: 'puppeteer' },
  isInstallable: true
}

/**
 * `blockSettleScript` runs inside a headless browser via `page.evaluate`, so it can only ever touch
 * `document` and `customElements` off `globalThis` — exactly what is stubbed here, standing in for the
 * page's own DOM without needing a real browser.
 */
describe('blockSettleScript', () => {
  let whenDefined: ReturnType<typeof mock.fn>

  beforeEach(() => {
    whenDefined = mock.fn(async () => {})
  })

  function stubDom({
    undefined: undefinedElements = [],
    all: allElements = []
  }: {
    undefined?: any[]
    all?: any[]
  }) {
    ;(globalThis as any).document = {
      querySelectorAll(selector: string) {
        if (selector === ':not(:defined)') {
          return undefinedElements
        }
        if (selector === '*') {
          return allElements
        }
        throw new Error(`Unexpected selector: ${selector}`)
      }
    }
    ;(globalThis as any).customElements = { whenDefined }
  }

  test('resolves immediately when the page has no block elements at all', async () => {
    const { blockSettleScript } = await import('./pdfExport.ts')
    stubDom({ undefined: [], all: [{ tagName: 'DIV' }] })

    await blockSettleScript(5)

    assert.equal(whenDefined.mock.callCount(), 0)
  })

  test('waits for every undefined block tag to upgrade, once per distinct tag', async () => {
    const { blockSettleScript } = await import('./pdfExport.ts')
    stubDom({
      undefined: [
        { tagName: 'BLOCK-DIAGRAM' },
        { tagName: 'BLOCK-DIAGRAM' },
        { tagName: 'BLOCK-PLANTUML' },
        // -> Not a block: an ordinary undefined custom element must not hold this up
        { tagName: 'IRON-ICON' }
      ],
      all: []
    })

    await blockSettleScript(5)

    assert.equal(whenDefined.mock.callCount(), 2)
    const tags = whenDefined.mock.calls.map((c) => c.arguments[0]).sort()
    assert.deepEqual(tags, ['block-diagram', 'block-plantuml'])
  })

  test('loops until every block reports no further update pending', async () => {
    const { blockSettleScript } = await import('./pdfExport.ts')
    let reads = 0
    const sequence = [true, true, false]
    const diagram = {
      tagName: 'BLOCK-DIAGRAM',
      get updateComplete() {
        const value = sequence[Math.min(reads, sequence.length - 1)]
        reads++
        return Promise.resolve(value)
      }
    }
    stubDom({ undefined: [], all: [diagram] })

    await blockSettleScript(10)

    // -> Three rounds: two still settling (`true`), the third stable (`false`) is what stops it —
    //    well short of the 10-round cap, which is what proves this stops on its own rather than
    //    always running to the limit
    assert.equal(reads, 3)
  })

  test('gives up after maxRounds rather than looping forever on a block that never settles', async () => {
    const { blockSettleScript } = await import('./pdfExport.ts')
    let reads = 0
    const stuck = {
      tagName: 'BLOCK-LIVE',
      get updateComplete() {
        reads++
        return Promise.resolve(true)
      }
    }
    stubDom({ undefined: [], all: [stuck] })

    await blockSettleScript(4)

    assert.equal(reads, 4)
  })

  test('ignores non-block custom elements even once they carry updateComplete', async () => {
    const { blockSettleScript } = await import('./pdfExport.ts')
    let reads = 0
    const notABlock = {
      tagName: 'MY-WIDGET',
      get updateComplete() {
        reads++
        return Promise.resolve(true)
      }
    }
    stubDom({ undefined: [], all: [notABlock] })

    await blockSettleScript(5)

    assert.equal(reads, 0)
  })
})

/**
 * `PdfExport.exportPdf` orchestrates a headless browser end to end. `launchBrowser` is mocked the
 * same way `models/import.ts`'s tests mock `runPandoc` — the one method that actually reaches outside
 * the process — so the business logic (cookie forwarding, the spoofed Host header, the URL navigated
 * to, the settle wait, closing the browser whether or not the export succeeded) is verified without a
 * real Puppeteer install.
 */
describe('PdfExport.exportPdf', () => {
  let isInstalled: ReturnType<typeof mock.fn>
  let pdfExport: typeof import('./pdfExport.ts').pdfExport
  let calls: any

  before(async () => {
    ;(globalThis as any).WIKI = {
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
    ;({ pdfExport } = await import('./pdfExport.ts'))
    isInstalled = (globalThis as any).WIKI.models.extensions.isInstalled
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  function fakeBrowser() {
    calls = {
      setCookie: [] as any[],
      setExtraHTTPHeaders: [] as any[],
      goto: [] as any[],
      evaluate: [] as any[],
      pdf: [] as any[],
      closed: false
    }
    const page = {
      setCookie: async (...args: any[]) => calls.setCookie.push(args),
      setExtraHTTPHeaders: async (...args: any[]) => calls.setExtraHTTPHeaders.push(args),
      goto: async (...args: any[]) => calls.goto.push(args),
      evaluate: async (...args: any[]) => {
        calls.evaluate.push(args)
      },
      pdf: async (...args: any[]) => {
        calls.pdf.push(args)
        return Buffer.from('%PDF-fake')
      }
    }
    return {
      newPage: async () => page,
      close: async () => {
        calls.closed = true
      }
    }
  }

  beforeEach(() => {
    isInstalled.mock.resetCalls()
    isInstalled.mock.mockImplementation(async () => true)
  })

  test('refuses when Puppeteer is not installed, same shape as renderPuppeteerMissing', async () => {
    isInstalled.mock.mockImplementation(async () => false)

    await assert.rejects(
      pdfExport.exportPdf({ hostname: 'wiki.example.com', port: 3000, path: 'home' }),
      (err: any) => {
        assert.equal(err.name, 'exportPuppeteerMissing')
        assert.equal(err.statusCode, 503)
        return true
      }
    )
  })

  test('forwards the session cookie scoped to loopback, spoofs the caller Host, and navigates over loopback', async () => {
    const browser = fakeBrowser()
    const launchBrowser = mock.method(pdfExport as any, 'launchBrowser', async () => browser)

    try {
      const pdf = await pdfExport.exportPdf({
        hostname: 'wiki.example.com',
        port: 3000,
        path: 'getting-started',
        sessionCookie: 'abc123.signature'
      })

      assert.equal(pdf.toString(), '%PDF-fake')
      assert.deepEqual(calls.setCookie[0][0], {
        name: '__Host-wikiSession',
        value: 'abc123.signature',
        url: 'http://127.0.0.1:3000',
        httpOnly: true,
        secure: true
      })
      assert.deepEqual(calls.setExtraHTTPHeaders[0][0], { Host: 'wiki.example.com' })
      assert.equal(calls.goto[0][0], 'http://127.0.0.1:3000/getting-started')
      assert.equal(calls.goto[0][1].waitUntil, 'networkidle0')
      assert.equal(calls.pdf.length, 1)
      assert.equal(calls.closed, true)
    } finally {
      launchBrowser.mock.restore()
    }
  })

  test('sets no cookie for an anonymous export of a public page', async () => {
    const browser = fakeBrowser()
    const launchBrowser = mock.method(pdfExport as any, 'launchBrowser', async () => browser)

    try {
      await pdfExport.exportPdf({ hostname: 'wiki.example.com', port: 3000, path: '' })
      assert.equal(calls.setCookie.length, 0)
      // -> Empty page path is the home page: a bare loopback root, not a dangling slash-less URL
      assert.equal(calls.goto[0][0], 'http://127.0.0.1:3000/')
    } finally {
      launchBrowser.mock.restore()
    }
  })

  test('gives up on a page whose async content never settles, RENDER_TIMEOUT-style, rather than hanging forever', async (t) => {
    const browser = fakeBrowser()
    ;(await browser.newPage()).evaluate = () => new Promise(() => {}) // never resolves
    const launchBrowser = mock.method(pdfExport as any, 'launchBrowser', async () => browser)
    t.mock.timers.enable({ apis: ['setTimeout'] })

    try {
      const promise = pdfExport.exportPdf({
        hostname: 'wiki.example.com',
        port: 3000,
        path: 'home'
      })
      /*
        `exportPdf` reaches the guarded `setTimeout` only after several of its own awaits
        (`ensureCanExport`, `launchBrowser`, `newPage`, `goto`) run first, and mock timers only
        intercept a `setTimeout` call made once they are already enabled — not one already pending.
        Interleaving a microtask yield with a clock advance, repeated a few times, lets that chain
        actually reach the real call before advancing past it; ticking before it exists is a no-op,
        and ticking well past 15s once it does is what fires it.
      */
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
        t.mock.timers.tick(20000)
      }
      await assert.rejects(promise, (err: any) => {
        assert.equal(err.name, 'exportSettleTimeout')
        assert.equal(err.statusCode, 504)
        return true
      })
      // -> The browser is still discarded, the same way a hung render is dropped rather than reused
      assert.equal(calls.closed, true)
    } finally {
      launchBrowser.mock.restore()
      t.mock.timers.reset()
    }
  })

  test('closes the browser even when the export fails partway through', async () => {
    const browser = fakeBrowser()
    ;(await browser.newPage()).goto = async () => {
      throw new Error('navigation failed')
    }
    const launchBrowser = mock.method(pdfExport as any, 'launchBrowser', async () => browser)

    try {
      await assert.rejects(
        pdfExport.exportPdf({ hostname: 'wiki.example.com', port: 3000, path: 'home' })
      )
      assert.equal(calls.closed, true)
    } finally {
      launchBrowser.mock.restore()
    }
  })
})
