import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { CustomError } from '../helpers/common.ts'

/**
 * Route-wiring tests for the page export routes:
 *   - `GET /sites/:siteId/pages/:pageId/export/pdf` (task 496)
 *   - `GET /sites/:siteId/pages/:pageId/export?format=markdown|html` (task 498)
 *
 * `WIKI.models.rendering.renderPdf` is stubbed rather than exercised for real: Puppeteer is an
 * optional extension not installed in this environment (see `models/rendering.test.ts` for the
 * gating unit test that IS exercised for real), so what is worth verifying here is the route's own
 * logic — permission/lock checks reusing `loadReadablePage`'s established pattern, that a thrown
 * `renderPuppeteerMissing` `CustomError` reaches the client as the standard `{ok,error,statusCode,
 * message}` shape (via the same `setErrorHandler` `index.ts` registers), and that a successful render
 * is streamed back with the right headers — not whether a real PDF comes out of Chromium.
 *
 * The Markdown/HTML export route needs no such stub — it just serves `content`/`render` off the page
 * already loaded — so its tests focus on the permission split the task calls for: `format=markdown`
 * needs `read:source` on top of `read:pages`, `format=html` needs only `read:pages`.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RENDER_HTML = '<p>Hello, PDF.</p>'
const RAW_MARKDOWN = '# Hello, Export\n\nSome **raw** source.'
const PDF_BYTES = Buffer.from('%PDF-1.7 fake pdf bytes')

let pageFixture: {
  id: string
  path: string
  title: string
  render: string
  content: string
  isLocked: boolean
} | null

let renderPdfBehavior: 'success' | 'unavailable'

/**
 * Mirrors the real model just enough to catch a wiring bug: `content` is only present on the
 * returned page when `withContent` was actually asked for, the same way `models/pages.ts` withholds
 * it — so a test asserting on `page.content` here is genuinely exercising the route's `withContent`
 * option, not just trusting it was passed.
 */
async function getPage(opts?: { withContent?: boolean }) {
  if (!pageFixture) return null
  if (opts?.withContent) {
    return pageFixture
  }
  const { content: _content, ...withoutContent } = pageFixture
  return withoutContent
}

async function renderPdf(html: string, options: { title: string }) {
  if (renderPdfBehavior === 'unavailable') {
    throw new CustomError(
      'renderPuppeteerMissing',
      'Exporting a page to PDF needs the Puppeteer extension, which is not installed.',
      503
    )
  }
  assert.equal(html, RENDER_HTML)
  assert.equal(options.title, pageFixture?.title)
  return PDF_BYTES
}

function actorForRequest(req: FastifyRequest) {
  const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
  return { permissions: [] as string[], pagePermissions: session?.testPagePermissions ?? [] }
}

function checkAccess(
  actor: { permissions: string[]; pagePermissions: string[] },
  permission: string
): boolean {
  return actor.pagePermissions.includes(permission)
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: { getPage },
      groups: { actorForRequest, checkAccess },
      rendering: { renderPdf },
      approvals: {
        pageViewerState: async () => ({
          canSuggestEdits: false,
          hasOpenSuggestion: false,
          canReview: false,
          pendingSubmissions: []
        })
      },
      pageWatching: { isWatching: async () => false }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerPageSchema(app)
  await registerApprovalSchema(app)
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-session']
    if (typeof raw === 'string') {
      ;(req as any).session = JSON.parse(raw)
    }
  })
  // -> Mirrors `index.ts`'s `setErrorHandler`, so a thrown `CustomError` is checked against the same
  //    `{ok,error,statusCode,message}` shape a real deployment answers with. Registered BEFORE the
  //    routes plugin: Fastify resolves a context's error handler from what was set at the point that
  //    context was registered, so setting it afterwards would silently leave these routes on the
  //    default (sensible/Fastify built-in) error serialization instead.
  app.setErrorHandler((error: any, req, reply) => {
    if (error.statusCode) {
      reply.code(error.statusCode).type('application/json').send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode,
        message: error.message
      })
    } else {
      reply.code(500).type('application/json').send({
        ok: false,
        error: 'Internal Server Error',
        statusCode: 500,
        message: 'Internal Server error'
      })
    }
  })
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  pageFixture = {
    id: PAGE_ID,
    path: 'docs/getting-started',
    title: 'Getting Started',
    render: RENDER_HTML,
    content: RAW_MARKDOWN,
    isLocked: false
  }
  renderPdfBehavior = 'success'
})

function sessionHeader(pagePermissions: string[]) {
  return {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'reader-1' },
      permissions: [],
      groups: [],
      testPagePermissions: pagePermissions
    })
  }
}

test('streams a PDF with the right headers when read:pages is granted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/pdf')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="getting-started.pdf"')
  assert.deepEqual(res.rawPayload, PDF_BYTES)
})

test('answers 404 when the page does not exist', async () => {
  pageFixture = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 404)
})

test('answers 404 when the requester lacks read:pages (folded into not-found, like the rest of the file)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`,
    headers: sessionHeader([])
  })
  assert.equal(res.statusCode, 404)
})

test('answers 403 when the page is locked and this session has not unlocked it', async () => {
  pageFixture!.isLocked = true
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().message, /password protected/)
})

test('answers 503 with the standard error shape when Puppeteer is not installed', async () => {
  renderPdfBehavior = 'unavailable'
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export/pdf`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), {
    ok: false,
    error: 'renderPuppeteerMissing',
    statusCode: 503,
    message: 'Exporting a page to PDF needs the Puppeteer extension, which is not installed.'
  })
})

/**
 * `GET /sites/:siteId/pages/:pageId/export?format=markdown|html` (task 498)
 */

test('format=markdown streams the raw content when read:source and read:pages are both granted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=markdown`,
    headers: sessionHeader(['read:pages', 'read:source'])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="getting-started.md"')
  assert.equal(res.body, RAW_MARKDOWN)
})

test('format=markdown answers 403 when only read:pages is granted (read:source missing)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=markdown`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().message, /source/)
})

test('format=html streams the stored render when only read:pages is granted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=html`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="getting-started.html"')
  assert.equal(res.body, RENDER_HTML)
})

test('format=html does not require read:source', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=html`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 200)
})

test('export answers 404 when the page does not exist, for either format', async () => {
  pageFixture = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=markdown`,
    headers: sessionHeader(['read:pages', 'read:source'])
  })
  assert.equal(res.statusCode, 404)
})

test('export answers 404 when the requester lacks read:pages (folded into not-found)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=html`,
    headers: sessionHeader([])
  })
  assert.equal(res.statusCode, 404)
})

test('export answers 403 when the page is locked and this session has not unlocked it', async () => {
  pageFixture!.isLocked = true
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=html`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().message, /password protected/)
})

test('export answers 400 for an unrecognized format', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=pdf`,
    headers: sessionHeader(['read:pages', 'read:source'])
  })
  assert.equal(res.statusCode, 400)
})
