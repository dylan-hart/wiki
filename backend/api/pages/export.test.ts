import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

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
 * Like `models/pages.ts`, withholds `content` unless `withContent` was asked for, so a test reading
 * the body exercises the route's `withContent` option.
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

test('format=markdown streams the raw content when write:pages is granted, with no read:source', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/export?format=markdown`,
    headers: sessionHeader(['read:pages', 'write:pages'])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, RAW_MARKDOWN)
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
