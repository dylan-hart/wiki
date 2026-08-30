import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerPageImportSchema } from './schemas/pageImport.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { SESSION_COOKIE_NAME } from '../helpers/security.ts'

/**
 * Route-level test for `GET /sites/:siteId/pages/:pageId/export/pdf`.
 *
 * Driving a real headless browser is `models/pdfExport.ts`'s job — `pdfExport.test.ts` covers the
 * browser-launch guard and the block-settle wait without a real browser. What belongs to the route,
 * and what this file checks, is the wiring: `read:pages` is checked in the handler (page rules, not
 * `config.permissions`), a missing or password-locked page is refused before the model is ever asked
 * to open a browser, and the request the model receives carries the caller's own hostname, this
 * instance's port, the page's path, and the raw `__Host-wikiSession` cookie value.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const PAGE_ID = '22222222-2222-2222-2222-222222222222'

let app: FastifyInstance
let checkAccess: ReturnType<typeof mock.fn>
let getPage: ReturnType<typeof mock.fn>
let exportPdf: ReturnType<typeof mock.fn>

before(async () => {
  checkAccess = mock.fn(() => true)
  getPage = mock.fn(async () => ({ id: PAGE_ID, path: 'getting-started', isLocked: false }))
  exportPdf = mock.fn(async () => Buffer.from('%PDF-fake'))

  ;(globalThis as any).WIKI = {
    config: { port: 3000 },
    models: {
      groups: {
        actorForRequest: () => ({ id: 'user-1', permissions: [] }),
        checkAccess,
        groupIdsForRequest: () => []
      },
      pages: {
        getPage
      },
      pageImport: {
        convertToMarkdown: mock.fn()
      },
      pdfExport: {
        exportPdf
      },
      // -> The route shares `limitRenders` (see `helpers/rateLimit.ts`) with re-render; always
      //    allowed here, since throttling itself is that file's own concern, not this route's
      rateLimits: {
        consume: mock.fn(async () => ({ allowed: true, retryAfter: 0 }))
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  // -> Stands in for the real `@fastify/session` and `@fastify/cookie` plugins: every request is an
  //    authenticated user carrying whatever `x-test-cookie` sends as its session cookie, unless it
  //    opts out with `x-test-anon`.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.headers['x-test-anon'] !== 'true') {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    }
    const cookie = req.headers['x-test-cookie']
    ;(req as any).cookies = typeof cookie === 'string' ? { [SESSION_COOKIE_NAME]: cookie } : {}
    done()
  })
  await registerErrorSchema(app)
  await registerApprovalSchema(app)
  await registerPageSchema(app)
  await registerPageImportSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  checkAccess.mock.resetCalls()
  checkAccess.mock.mockImplementation(() => true)
  getPage.mock.resetCalls()
  getPage.mock.mockImplementation(async () => ({
    id: PAGE_ID,
    path: 'getting-started',
    isLocked: false
  }))
  exportPdf.mock.resetCalls()
  exportPdf.mock.mockImplementation(async () => Buffer.from('%PDF-fake'))
})

function exportUrl() {
  return `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`
}

test('refuses a caller without read:pages on this page before opening a browser', async () => {
  checkAccess.mock.mockImplementation(() => false)

  const res = await app.inject({ method: 'GET', url: exportUrl() })
  assert.equal(res.statusCode, 404)
  assert.equal(exportPdf.mock.callCount(), 0)
})

test('answers 404 for a page that does not exist', async () => {
  getPage.mock.mockImplementation(async () => null)

  const res = await app.inject({ method: 'GET', url: exportUrl() })
  assert.equal(res.statusCode, 404)
  assert.equal(exportPdf.mock.callCount(), 0)
})

test('refuses a password-protected page without opening a browser', async () => {
  getPage.mock.mockImplementation(async () => ({
    id: PAGE_ID,
    path: 'secret',
    isLocked: true
  }))

  const res = await app.inject({ method: 'GET', url: exportUrl() })
  assert.equal(res.statusCode, 403)
  assert.equal(exportPdf.mock.callCount(), 0)
})

test('surfaces the model refusing because Puppeteer is not installed', async () => {
  exportPdf.mock.mockImplementation(async () => {
    const err: any = new Error('Exporting a page to PDF needs the Puppeteer extension.')
    err.name = 'exportPuppeteerMissing'
    err.statusCode = 503
    throw err
  })

  const res = await app.inject({ method: 'GET', url: exportUrl() })
  assert.equal(res.statusCode, 503)
})

test("forwards the caller hostname, this instance's port, the page path and the raw session cookie", async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(),
    headers: { host: 'wiki.example.com', 'x-test-cookie': 'abc123.signature' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(exportPdf.mock.callCount(), 1)
  assert.deepEqual(exportPdf.mock.calls[0].arguments[0], {
    hostname: 'wiki.example.com',
    port: 3000,
    path: 'getting-started',
    sessionCookie: 'abc123.signature'
  })
})

test('answers with the PDF bytes as a downloadable attachment', async () => {
  const res = await app.inject({ method: 'GET', url: exportUrl() })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/pdf')
  assert.match(
    res.headers['content-disposition'] as string,
    /^attachment; filename="getting-started\.pdf"$/
  )
  assert.equal(res.rawPayload.toString(), '%PDF-fake')
})

test('forwards no cookie for an anonymous requester exporting a public page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(),
    headers: { 'x-test-anon': 'true' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal((exportPdf.mock.calls[0].arguments[0] as any).sessionCookie, null)
})
