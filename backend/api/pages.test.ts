import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'

/**
 * Regression test for `GET /_api/sites/:siteId/pages/:pageIdOrHash`'s `withContent=true` path:
 * `PAGE_PERMISSIONS` in `pages.ts` declares `read:source`, but only `read:pages` was ever checked
 * before returning the raw `content` field — so a reader granted `read:pages` but not `read:source`
 * (a group that may see a page but not its markdown, e.g. one meant only to browse the rendered
 * result) could pull the source anyway by asking for `withContent=true`. Fixed by checking
 * `read:source` too, but only when content was actually requested — the plain page view (`render`
 * only) needs no more than `read:pages`, exactly as before.
 *
 * `WIKI.models.groups.actorForRequest` / `checkAccess` are stubbed to a minimal permission set
 * carried on the test session (`testPagePermissions`) rather than pulling in the real page-rules
 * resolver — this is a route-wiring test, not a `helpers/pageRules.ts` test (see
 * `helpers/pageRules.test.ts` for that). `WIKI.models.pages.getPage` is stubbed to hand back
 * `content` exactly when asked, mirroring the real model's `withContent` contract, so the test
 * would fail the same way the bug did if the route stopped checking `read:source`.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUTHOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PAGE_HASH = 'deadbeef'
const RENDER_HTML = '<p>Hello</p>'
const RAW_CONTENT = '# Hello'

async function getPage({ withContent }: { withContent?: boolean }) {
  return {
    id: PAGE_ID,
    path: 'foo',
    hash: PAGE_HASH,
    alias: null,
    title: 'Foo',
    description: null,
    icon: null,
    locale: 'en',
    editor: 'markdown',
    contentType: 'markdown',
    publishState: 'published',
    publishStartDate: null,
    publishEndDate: null,
    isBrowsable: true,
    isSearchable: true,
    isLocked: false,
    relations: [],
    tags: [],
    toc: [],
    render: RENDER_HTML,
    ...(withContent ? { content: RAW_CONTENT } : {}),
    allowComments: false,
    allowContributions: false,
    allowRatings: false,
    showSidebar: true,
    showTags: true,
    showToc: true,
    tocDepth: { min: 1, max: 2 },
    scriptJsLoad: '',
    scriptJsUnload: '',
    scriptCss: '',
    navigationId: null,
    navigationMode: 'default',
    authorId: AUTHOR_ID,
    authorName: 'Test Author',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function actorForRequest(req: FastifyRequest) {
  const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
  // -> `permissions` (empty here) is the GLOBAL list `pagePermissionsFor`'s `manage:system` bypass
  //    reads; `pagePermissions` is this test's stand-in for what a group's RULES would grant.
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
  // -> Fakes what a real session cookie provides, keyed off a header instead so each test can set
  //    its own reader without a real @fastify/session plugin or database in the loop.
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-session']
    if (typeof raw === 'string') {
      ;(req as any).session = JSON.parse(raw)
    }
  })
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
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

test('read:pages alone renders the page without withContent', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.render, RENDER_HTML)
  assert.equal(body.content, undefined)
})

test('read:pages without read:source is forbidden from withContent=true', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
    headers: sessionHeader(['read:pages'])
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().content, undefined)
})

test('read:pages plus read:source is allowed withContent=true', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
    headers: sessionHeader(['read:pages', 'read:source'])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().content, RAW_CONTENT)
})

test('no read:pages at all is forbidden regardless of withContent', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
    headers: sessionHeader([])
  })
  assert.equal(res.statusCode, 403)
})
