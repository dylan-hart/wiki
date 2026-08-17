import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * `renderPdf`'s gating, pure-unit — no Puppeteer, no browser, no database.
 *
 * The rest of `renderPdf` (launching Chromium, setting content, calling `page.pdf`) needs a real
 * Puppeteer install to exercise meaningfully, and Puppeteer is an optional extension this environment
 * does not have installed (see `backend/package.json`'s `allowScripts` note and the absence of the
 * package from `node_modules`) — mocking `import('puppeteer')` itself would mostly be re-describing
 * `launchBrowser` rather than verifying it. What IS a pure function of `WIKI.models.extensions`, and
 * therefore worth a unit test here, is that a missing extension is refused before any browser is
 * touched, with the same `renderPuppeteerMissing` `CustomError` (503) the frontend-bundle renderer
 * already throws for the same reason — see `isAvailable`/`ensureCanRender`.
 */
describe('rendering renderPdf gating (unit)', () => {
  let renderingModel: typeof import('./rendering.ts').rendering

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getDefinition: () => null,
          isInstalled: async () => false
        }
      },
      logger: { debug: () => {}, warn: () => {} }
    }
    ;({ rendering: renderingModel } = await import('./rendering.ts'))
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('refuses when the Puppeteer extension is not installed', async () => {
    await assert.rejects(
      renderingModel.renderPdf('<p>Hello</p>', { title: 'Test Page' }),
      (err: any) => {
        assert.equal(err.name, 'renderPuppeteerMissing')
        assert.equal(err.statusCode, 503)
        assert.match(err.message, /Puppeteer/)
        return true
      }
    )
  })
})
