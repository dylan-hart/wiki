import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import commentsRoutes from './comments.ts'
import { registerSchemas as registerCommentSchema } from './schemas/comment.ts'

/**
 * Unit tests for the comments route wiring (task 607): the list/create endpoints, their permission
 * gating, and the `replyTo` validation edge case.
 *
 * `WIKI.models.comments` is stubbed rather than backed by a real model — `models/comments.ts` is
 * Feature #389's file, out of scope for this branch (see the contract comment atop `comments.ts`).
 * `WIKI.models.pages.getPage` and `WIKI.models.groups.{actorForRequest,checkAccess}` are stubbed too,
 * standing in for `helpers/pageRules.ts` rule resolution so this stays a self-contained test of THIS
 * file's wiring rather than a re-test of page-rule resolution, which has its own test coverage.
 *
 * Auth/permissions are simulated per request via `x-test-user-id` / `x-test-permissions` headers
 * (comma-separated), read by a test-only `onRequest` hook that fills in `req.session` the way the
 * real session plugin would — there is no real session plugin in this bare fastify instance.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const PAGE_ID = '22222222-2222-2222-2222-222222222222'
const LOCKED_PAGE_ID = '33333333-3333-3333-3333-333333333333'
const OTHER_PAGE_ID = '44444444-4444-4444-4444-444444444444'
const EXISTING_COMMENT_ID = '55555555-5555-5555-5555-555555555555'
const OTHER_PAGE_COMMENT_ID = '66666666-6666-6666-6666-666666666666'

const pagesById: Record<string, any> = {
  [PAGE_ID]: { id: PAGE_ID, path: 'en/test-page', locale: 'en', tags: [], isLocked: false },
  [LOCKED_PAGE_ID]: {
    id: LOCKED_PAGE_ID,
    path: 'en/locked-page',
    locale: 'en',
    tags: [],
    isLocked: true
  }
}

const threadsByPage: Record<string, any[]> = {
  [PAGE_ID]: [
    {
      id: EXISTING_COMMENT_ID,
      siteId: SITE_ID,
      pageId: PAGE_ID,
      authorId: 'author-1',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      replyTo: null,
      content: 'First comment',
      render: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      replies: []
    }
  ],
  [OTHER_PAGE_ID]: [
    {
      id: OTHER_PAGE_COMMENT_ID,
      siteId: SITE_ID,
      pageId: OTHER_PAGE_ID,
      authorId: 'author-2',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      replyTo: null,
      content: 'A comment on a different page',
      render: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      replies: []
    }
  ]
}

const created: any[] = []

async function getPage({ id }: { id?: string }) {
  return id ? (pagesById[id] ?? null) : null
}

function actorForRequest(req: FastifyRequest) {
  return { groupIds: [], permissions: req.session?.permissions ?? [] }
}

function checkAccess(actor: { permissions: string[] }, permission: string) {
  return actor.permissions.includes(permission)
}

async function listForPage(pageId: string) {
  return threadsByPage[pageId] ?? []
}

async function create(input: {
  siteId: string
  pageId: string
  authorId: string
  replyTo: string | null
  content: string
}) {
  const record = {
    id: `created-${created.length + 1}`,
    siteId: input.siteId,
    pageId: input.pageId,
    authorId: input.authorId,
    authorName: 'Test Author',
    authorEmail: 'author@example.com',
    replyTo: input.replyTo,
    content: input.content,
    render: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  }
  created.push(record)
  return record
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: { getPage },
      groups: { actorForRequest, checkAccess },
      comments: { listForPage, create }
    }
  }

  app = fastify({
    ajv: { plugins: [[ajvFormats.default, {}] as any] }
  })
  app.addHook('onRequest', async (req) => {
    const userId = req.headers['x-test-user-id'] as string | undefined
    const permissions = ((req.headers['x-test-permissions'] as string | undefined) ?? '')
      .split(',')
      .filter(Boolean)
    req.session = (
      userId
        ? { authenticated: true, user: { id: userId }, permissions }
        : { authenticated: false, permissions }
    ) as any
  })
  await app.register(fastifySensible)
  await registerCommentSchema(app)
  await app.register(commentsRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  created.length = 0
})

test('GET list: 404 when the page does not exist', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/00000000-0000-0000-0000-000000000000/comments`,
    headers: { 'x-test-permissions': 'read:pages,read:comments' }
  })
  assert.equal(res.statusCode, 404)
})

test('GET list: 404 (not 403) when the caller may not read the page at all', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:comments' } // -> no read:pages
  })
  assert.equal(res.statusCode, 404) // -> loadReadablePage folds "not permitted" into "not found"
})

test('GET list: 403 when the page is readable but read:comments is not granted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages' }
  })
  assert.equal(res.statusCode, 403)
})

test('GET list: 403 on a password-protected page', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${LOCKED_PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,read:comments' }
  })
  assert.equal(res.statusCode, 403)
})

test('GET list: anonymous-safe, and masks authorEmail', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,read:comments' } // -> no x-test-user-id: anonymous
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.length, 1)
  assert.equal(body[0].id, EXISTING_COMMENT_ID)
  assert.equal(body[0].authorName, 'Alice')
  assert.equal(body[0].authorEmail, null)
})

test('POST create: 401 when not authenticated', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello' }
  })
  assert.equal(res.statusCode, 401)
})

test('POST create: 403 when write:comments is not granted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages' },
    payload: { content: 'Hello' }
  })
  assert.equal(res.statusCode, 403)
})

test('POST create: 400 when replyTo does not exist on this page', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello', replyTo: '77777777-7777-7777-7777-777777777777' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
})

test('POST create: 400 when replyTo names a comment on a different page', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello', replyTo: OTHER_PAGE_COMMENT_ID }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
})

test('POST create: 200 creates a top-level comment and includes authorEmail', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello, world' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.content, 'Hello, world')
  assert.equal(body.replyTo, null)
  assert.equal(body.authorEmail, 'author@example.com')
  assert.equal(created.length, 1)
  assert.equal(created[0].authorId, 'user-1')
})

test('POST create: 200 creates a reply to an existing comment on the same page', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'A reply', replyTo: EXISTING_COMMENT_ID }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.replyTo, EXISTING_COMMENT_ID)
  assert.equal(created.length, 1)
})
