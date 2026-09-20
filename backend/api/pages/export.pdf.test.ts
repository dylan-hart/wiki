import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { SESSION_COOKIE_NAME } from '../../helpers/security.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

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

  const wiki = {
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
      // -> The route's `limitRenders` preHandler consumes from this; always allowed here.
      rateLimits: {
        consume: mock.fn(async () => ({ allowed: true, retryAfter: 0 }))
      }
    }
  }

  app = await buildTestApp({
    routes: pagesRoutes,
    ajv: true,
    wiki,
    // -> Also stands in for `@fastify/cookie`: the route reads its cookie off `req.cookies`.
    session: (req: any) => {
      const cookie = req.headers['x-test-cookie']
      req.cookies = typeof cookie === 'string' ? { [SESSION_COOKIE_NAME]: cookie } : {}
      return req.headers['x-test-anon'] === 'true'
        ? undefined
        : { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    }
  })
})

after(() => closeTestApp(app))

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

test('refuses an anonymous caller before checking read:pages or opening a browser', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(),
    headers: { 'x-test-anon': 'true' }
  })
  assert.equal(res.statusCode, 401)
  assert.equal(checkAccess.mock.callCount(), 0)
  assert.equal(getPage.mock.callCount(), 0)
  assert.equal(exportPdf.mock.callCount(), 0)
})

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

test('forwards no cookie when an authenticated caller sent none', async () => {
  const res = await app.inject({ method: 'GET', url: exportUrl() })

  assert.equal(res.statusCode, 200)
  assert.equal((exportPdf.mock.calls[0].arguments[0] as any).sessionCookie, null)
})
