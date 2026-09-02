import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import pagesRoutes from './pages.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/:pageId/export?format=markdown|html` (task 498).
 *
 * `GET /sites/:siteId/pages/:pageId/export/pdf` (task 496) is deliberately not covered here: this
 * file originally also tested that route against `models/rendering.ts#renderPdf()`, but that PDF
 * path was retired at merge-review time in favor of `models/pdfExport.ts`'s richer, live-page-view
 * export (see `docs/variances.md`'s "PDF export: two competing implementations reconciled" entry) --
 * `api/pagesExportPdf.test.ts` is the winning route's own dedicated test file.
 *
 * The Markdown/HTML export route needs no Puppeteer stub — it just serves `content`/`render` off the
 * page already loaded — so its tests focus on the permission split the task calls for:
 * `format=markdown` needs `read:source` on top of `read:pages`, `format=html` needs only `read:pages`.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RENDER_HTML = '<p>Hello, PDF.</p>'
const RAW_MARKDOWN = '# Hello, Export\n\nSome **raw** source.'

let pageFixture: {
  id: string
  path: string
  title: string
  render: string
  content: string
  isLocked: boolean
} | null

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
  const wiki = {
    models: {
      pages: { getPage },
      groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
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

  app = await buildTestApp({
    routes: pagesRoutes,
    ajv: true,
    wiki,
    session: 'header'
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  pageFixture = {
    id: PAGE_ID,
    path: 'docs/getting-started',
    title: 'Getting Started',
    render: RENDER_HTML,
    content: RAW_MARKDOWN,
    isLocked: false
  }
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
