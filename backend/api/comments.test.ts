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
const GUEST_COMMENT_ID = '88888888-8888-8888-8888-888888888888'
const NONEXISTENT_COMMENT_ID = '99999999-9999-9999-9999-999999999999'

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

function freshComments(): Record<string, any> {
  return {
    [EXISTING_COMMENT_ID]: {
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
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    },
    [OTHER_PAGE_COMMENT_ID]: {
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
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    },
    [GUEST_COMMENT_ID]: {
      id: GUEST_COMMENT_ID,
      siteId: SITE_ID,
      pageId: PAGE_ID,
      authorId: null,
      authorName: 'Some Guest',
      authorEmail: 'guest@example.com',
      replyTo: null,
      content: 'A guest comment',
      render: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    }
  }
}

let commentsById: Record<string, any> = freshComments()
const updatedIds: string[] = []
const deletedIds: string[] = []

async function getComment(id: string) {
  return commentsById[id] ?? null
}

async function updateComment(id: string, { content }: { content: string }) {
  const record = commentsById[id]
  record.content = content
  record.updatedAt = new Date('2026-01-03T00:00:00.000Z')
  updatedIds.push(id)
  return record
}

async function deleteComment(id: string) {
  delete commentsById[id]
  deletedIds.push(id)
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
  authorId: string | null
  replyTo: string | null
  content: string
  guestName?: string | null
  guestEmail?: string | null
  guestIp?: string | null
}) {
  const record = {
    id: `created-${created.length + 1}`,
    siteId: input.siteId,
    pageId: input.pageId,
    authorId: input.authorId,
    authorName: input.authorId ? 'Test Author' : (input.guestName ?? 'Guest'),
    authorEmail: input.authorId ? 'author@example.com' : (input.guestEmail ?? null),
    guestName: input.guestName ?? null,
    guestEmail: input.guestEmail ?? null,
    guestIp: input.guestIp ?? null,
    replyTo: input.replyTo,
    content: input.content,
    render: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  }
  created.push(record)
  return record
}

const emittedEvents: { event: string; data: Record<string, any> }[] = []

async function emit(event: string, data: Record<string, any> = {}) {
  emittedEvents.push({ event, data })
  return 1
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: { getPage },
      groups: { actorForRequest, checkAccess },
      comments: {
        listForPage,
        create,
        get: getComment,
        update: updateComment,
        delete: deleteComment
      },
      hooks: { emit }
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
  commentsById = freshComments()
  updatedIds.length = 0
  deletedIds.length = 0
  emittedEvents.length = 0
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

/**
 * Guest posting (task 609): anonymous is now allowed through, provided `mayOnPage` grants
 * `write:comments` to the anonymous actor (a Guests group rule) — mirroring 2.5.x's anonymous
 * comment support. `x-test-permissions` with no `x-test-user-id` simulates exactly that rule.
 */

test('POST create: 403 when anonymous and write:comments is not granted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages' }, // -> no write:comments, no session
    payload: { content: 'Hello', guestName: 'Casey', guestEmail: 'casey@example.com' }
  })
  assert.equal(res.statusCode, 403)
})

test('POST create: 400 when anonymous, write:comments is granted, but guestName/guestEmail are missing', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' }, // -> no session
    payload: { content: 'Hello' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
})

test('POST create: 400 when anonymous and only guestEmail is missing', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello', guestName: 'Casey' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
})

test('POST create: 400 when guestEmail is not a valid email (schema-level format check)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello', guestName: 'Casey', guestEmail: 'not-an-email' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
})

test('POST create: 200 creates a guest comment, captures req.ip, and includes the guest email', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' },
    remoteAddress: '203.0.113.7',
    payload: { content: 'Hello from a guest', guestName: 'Casey', guestEmail: 'casey@example.com' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.authorId, null)
  assert.equal(body.authorName, 'Casey')
  assert.equal(body.authorEmail, 'casey@example.com')
  assert.equal(created.length, 1)
  assert.equal(created[0].authorId, null)
  assert.equal(created[0].guestName, 'Casey')
  assert.equal(created[0].guestEmail, 'casey@example.com')
  assert.equal(created[0].guestIp, '203.0.113.7')
})

test('POST create: 400 when an authenticated request includes guestName/guestEmail', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hello', guestName: 'Casey', guestEmail: 'casey@example.com' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(created.length, 0)
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

  // -> Task 610: creating a comment queues a `comment:new` webhook event.
  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].event, 'comment:new')
  assert.equal(emittedEvents[0].data.id, body.id)
  assert.equal(emittedEvents[0].data.pageId, PAGE_ID)
  assert.equal(emittedEvents[0].data.siteId, SITE_ID)
  assert.equal(emittedEvents[0].data.authorId, 'user-1')
  assert.equal(emittedEvents[0].data.isGuest, false)
  assert.equal(emittedEvents[0].data.content, 'Hello, world')
})

test('POST create: guest comment emits comment:new with isGuest true and a null authorId', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
    headers: { 'x-test-permissions': 'read:pages,write:comments' },
    payload: { content: 'Hi', guestName: 'Casey', guestEmail: 'casey@example.com' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].event, 'comment:new')
  assert.equal(emittedEvents[0].data.authorId, null)
  assert.equal(emittedEvents[0].data.isGuest, true)
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

/**
 * PATCH/DELETE (task 608): the self-authorship policy.
 *
 * This fork diverges from 2.5.x's `server/models/comments.js`, which requires `manage:comments` for
 * every edit/delete with no exception. Here, a comment's own author may edit/delete it without
 * `manage:comments` — see the policy comment at the permission check in `comments.ts`. Both routes
 * are expected to apply the identical rule, so most of the cases below are run against both methods
 * via the `method` table.
 */
for (const method of ['PATCH', 'DELETE'] as const) {
  const send = (url: string, headers: Record<string, string>) =>
    app.inject({
      method,
      url,
      headers,
      ...(method === 'PATCH' ? { payload: { content: 'Edited content' } } : {})
    })

  test(`${method}: 404 when the page does not exist`, async () => {
    const res = await send(
      `/sites/${SITE_ID}/pages/00000000-0000-0000-0000-000000000000/comments/${EXISTING_COMMENT_ID}`,
      { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' }
    )
    assert.equal(res.statusCode, 404)
  })

  test(`${method}: 404 (not 403) when the caller may not read the page at all`, async () => {
    const res = await send(
      `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
      { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:comments' } // -> no read:pages
    )
    assert.equal(res.statusCode, 404)
  })

  test(`${method}: 403 when the page is readable but read:comments is not granted`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`, {
      'x-test-user-id': 'author-1',
      'x-test-permissions': 'read:pages'
    })
    assert.equal(res.statusCode, 403)
  })

  test(`${method}: 403 on a password-protected page`, async () => {
    const res = await send(
      `/sites/${SITE_ID}/pages/${LOCKED_PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
      { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' }
    )
    assert.equal(res.statusCode, 403)
  })

  test(`${method}: 404 when the comment does not exist on this page`, async () => {
    const res = await send(
      `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${NONEXISTENT_COMMENT_ID}`,
      { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' }
    )
    assert.equal(res.statusCode, 404)
  })

  test(`${method}: 404 when the comment exists but on a different page`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${OTHER_PAGE_COMMENT_ID}`, {
      'x-test-user-id': 'author-1',
      'x-test-permissions': 'read:pages,read:comments'
    })
    assert.equal(res.statusCode, 404)
  })

  test(`${method}: 403 when a non-author without manage:comments tries to act on someone else's comment`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`, {
      'x-test-user-id': 'someone-else',
      'x-test-permissions': 'read:pages,read:comments'
    })
    assert.equal(res.statusCode, 403)
  })

  test(`${method}: 200/204 lets the comment's own author act without manage:comments`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`, {
      'x-test-user-id': 'author-1',
      'x-test-permissions': 'read:pages,read:comments'
    })
    assert.ok(res.statusCode === 200 || res.statusCode === 204)
  })

  test(`${method}: 200/204 lets manage:comments override, even for someone else's comment`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`, {
      'x-test-user-id': 'a-moderator',
      'x-test-permissions': 'read:pages,read:comments,manage:comments'
    })
    assert.ok(res.statusCode === 200 || res.statusCode === 204)
  })

  test(`${method}: 403 for a guest-authored comment, even for the requester who posted it anonymously`, async () => {
    // -> A guest comment has authorId === null: there is no account to match `actor.id` against, so
    //    self-authorship can never apply here regardless of who is asking or what they claim.
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${GUEST_COMMENT_ID}`, {
      'x-test-user-id': 'anyone',
      'x-test-permissions': 'read:pages,read:comments'
    })
    assert.equal(res.statusCode, 403)
  })

  test(`${method}: 403 for a guest-authored comment when unauthenticated`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${GUEST_COMMENT_ID}`, {
      'x-test-permissions': 'read:pages,read:comments'
    })
    assert.equal(res.statusCode, 403)
  })

  test(`${method}: manage:comments still overrides on a guest-authored comment`, async () => {
    const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${GUEST_COMMENT_ID}`, {
      'x-test-user-id': 'a-moderator',
      'x-test-permissions': 'read:pages,read:comments,manage:comments'
    })
    assert.ok(res.statusCode === 200 || res.statusCode === 204)
  })
}

test('PATCH: 200 returns the updated comment with the new content', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
    headers: { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' },
    payload: { content: 'Updated content' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.id, EXISTING_COMMENT_ID)
  assert.equal(body.content, 'Updated content')
  assert.deepEqual(updatedIds, [EXISTING_COMMENT_ID])

  // -> Task 610: editing a comment queues a `comment:edit` webhook event.
  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].event, 'comment:edit')
  assert.equal(emittedEvents[0].data.id, EXISTING_COMMENT_ID)
  assert.equal(emittedEvents[0].data.pageId, PAGE_ID)
  assert.equal(emittedEvents[0].data.siteId, SITE_ID)
  assert.equal(emittedEvents[0].data.authorId, 'author-1')
  assert.equal(emittedEvents[0].data.content, 'Updated content')
})

test('DELETE: 204 and actually removes the comment', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
    headers: { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' }
  })
  assert.equal(res.statusCode, 204)
  assert.deepEqual(deletedIds, [EXISTING_COMMENT_ID])

  // -> Task 610: deleting a comment queues a `comment:delete` webhook event.
  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].event, 'comment:delete')
  assert.equal(emittedEvents[0].data.id, EXISTING_COMMENT_ID)
  assert.equal(emittedEvents[0].data.pageId, PAGE_ID)
  assert.equal(emittedEvents[0].data.siteId, SITE_ID)
})
