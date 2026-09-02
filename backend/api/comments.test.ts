import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import commentsRoutes from './comments.ts'
import { registerSchemas as registerCommentSchema } from './schemas/comment.ts'
import { registerSchemas as registerCommentProviderSchema } from './schemas/commentProvider.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerParamsSchemas } from './schemas/params.ts'

/**
 * Two independently-built route test suites merged at merge-review time (see `comments.ts`'s own
 * header for the merge story). The first covers the comment-provider endpoints (Task 617, Feature
 * 394); the second covers the page-scoped CRUD endpoints (Feature 391) plus the self-authorship
 * policy (task 608). The site-wide moderation listing's OWN route tests live in
 * `comments.admin.test.ts` — Feature 391's competing design for that same route was discarded during
 * the merge (see `comments.ts`), so its site-wide-specific tests (`mayManageCommentsAnywhere`,
 * `listForSite`) were dropped along with it rather than adapted.
 */
describe('comment provider routes', () => {
  /**
   * Route-level test for `GET/PUT /sites/:siteId/comments/providers` (Task 617, Feature 394).
   *
   * `WIKI.models.sites` and `WIKI.models.commentProviders` are stubbed rather than pulling in the real
   * db/schema/drizzle graph — `models/commentProviders.test.ts` is what covers the model's own logic
   * (discovery, sync, the single-active-provider invariant) against a real database. This file only
   * proves the route wiring: the shared site preHandler, status codes, and how the model's return values and
   * thrown errors map onto the HTTP response.
   */
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const sites: Record<string, any> = {
    [SITE_ID]: { id: SITE_ID, hostname: 'test.localhost', isEnabled: true }
  }

  const ALPHA_PROVIDER = {
    id: 'provider-1',
    module: 'alpha',
    isEnabled: true,
    title: 'Alpha Provider',
    description: '',
    icon: '',
    vendor: '',
    website: '',
    isAvailable: true,
    props: {},
    config: {}
  }

  let setActiveProviderCalls: Array<{ siteId: string; module: string; config: Record<string, any> }>

  async function getSiteProviders(siteId: string) {
    return siteId === SITE_ID ? [ALPHA_PROVIDER] : []
  }

  async function setActiveProvider(siteId: string, moduleKey: string, config: Record<string, any>) {
    setActiveProviderCalls.push({ siteId, module: moduleKey, config })
    if (moduleKey === 'ghost') {
      return null
    }
    if (moduleKey === 'invalid') {
      throw new Error('Some Prop must be a string.')
    }
    if (moduleKey === 'unselectable') {
      throw new Error(
        'Unselectable Provider cannot be activated: it has no server-side implementation and does not declare codeTemplate.'
      )
    }
    return { ...ALPHA_PROVIDER, module: moduleKey, config }
  }

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites,
      models: {
        commentProviders: { getSiteProviders, setActiveProvider }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerCommentSchema(app)
    await registerCommentProviderSchema(app)
    // -> The unknown-site 404 lives in this one hook now (spec D1), not in each route handler, so a
    //    plugin-only app has to register it to answer that case the way the real app does.
    app.addHook('preHandler', siteEnabledPreHandler)
    await registerParamsSchemas(app)
    await app.register(commentsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('GET .../comments/providers 404s for a site that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sites/00000000-0000-0000-0000-000000000000/comments/providers'
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET .../comments/providers returns the site’s providers', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/comments/providers` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [ALPHA_PROVIDER])
  })

  test('PUT .../comments/providers 404s for a site that does not exist', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/sites/00000000-0000-0000-0000-000000000000/comments/providers',
      payload: { module: 'alpha' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('PUT .../comments/providers activates the named module with its config', async () => {
    setActiveProviderCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/comments/providers`,
      payload: { module: 'alpha', config: { apiKey: 'xyz' } }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().module, 'alpha')
    assert.deepEqual(setActiveProviderCalls, [
      { siteId: SITE_ID, module: 'alpha', config: { apiKey: 'xyz' } }
    ])
  })

  test('PUT .../comments/providers 404s for a module nothing on disk declares', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/comments/providers`,
      payload: { module: 'ghost' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('PUT .../comments/providers turns a model validation error into a 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/comments/providers`,
      payload: { module: 'invalid' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /must be a string/)
  })

  // -> OpenProject #1962: a module `models/commentProviders.ts#setActiveProvider` refuses as
  //    non-selectable (no server-side implementation, no `codeTemplate`) must not become storable
  //    just because it made it past this route's own site-existence check.
  test('PUT .../comments/providers turns a non-selectable-module error into a 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/comments/providers`,
      payload: { module: 'unselectable' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /cannot be activated/i)
  })
})

describe('page-scoped comment routes', () => {
  /**
   * Unit tests for the comments route wiring (task 607): the list/create/edit/delete endpoints,
   * their permission gating, and the `replyTo` validation edge case.
   *
   * `WIKI.models.comments` is stubbed with an in-memory fake rather than a real model.
   * `WIKI.models.users.getById` is also stubbed — `resolveAuthorName` (see `comments.ts`) and the
   * POST route's own authorEmail lookup both call it to resolve an authenticated author's display
   * name/address, since `create`/`update`/`get` return the flat stored row, not a joined one (only
   * `listForPage`'s own join resolves `authorName` directly).
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

  const usersById: Record<string, { name: string; email: string }> = {
    'user-1': { name: 'Test Author', email: 'author@example.com' },
    'author-1': { name: 'Alice', email: 'alice@example.com' },
    'author-2': { name: 'Bob', email: 'bob@example.com' }
  }

  async function getById(id: string) {
    return usersById[id] ?? null
  }

  const NO_COMMENTS_PAGE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

  const pagesById: Record<string, any> = {
    [PAGE_ID]: {
      id: PAGE_ID,
      path: 'en/test-page',
      locale: 'en',
      tags: [],
      isLocked: false,
      allowComments: true
    },
    [LOCKED_PAGE_ID]: {
      id: LOCKED_PAGE_ID,
      path: 'en/locked-page',
      locale: 'en',
      tags: [],
      isLocked: true,
      allowComments: true
    },
    // -> OpenProject #935: `allowComments: false` on the page itself, distinct from the site-wide
    //    `features.comments` flag below -- either one alone must refuse POST.
    [NO_COMMENTS_PAGE_ID]: {
      id: NO_COMMENTS_PAGE_ID,
      path: 'en/no-comments-page',
      locale: 'en',
      tags: [],
      isLocked: false,
      allowComments: false
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
        guestName: null,
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
        guestName: null,
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
        guestName: 'Some Guest',
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
    await emitCommentHook('comment:edit', record, await resolveAuthorNameForTest(record))
    return record
  }

  async function deleteComment(id: string) {
    const existing = commentsById[id]
    delete commentsById[id]
    deletedIds.push(id)
    if (existing) {
      await emitCommentHook('comment:delete', existing)
    }
  }

  const created: any[] = []

  // -> `limitGuestComments` (OpenProject #2256): allowed by default so every pre-existing POST test
  //    keeps passing; a dedicated test below overrides this to exercise the 429 path.
  let rateLimitVerdict = { allowed: true, hits: 1, retryAfter: 0 }
  const rateLimitConsumeCalls: { key: string; policy: any }[] = []

  async function consumeRateLimit(key: string, policy: any) {
    rateLimitConsumeCalls.push({ key, policy })
    return rateLimitVerdict
  }

  async function getPage({ id }: { id?: string }) {
    return id ? (pagesById[id] ?? null) : null
  }

  function actorForRequest(req: FastifyRequest) {
    return { permissions: req.session?.permissions ?? [] }
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
    await emitCommentHook('comment:new', record, await resolveAuthorNameForTest(record))
    return record
  }

  const emittedEvents: { event: string; siteId: string | null; data: Record<string, any> }[] = []

  async function emit(event: string, siteId: string | null, data: Record<string, any> = {}) {
    emittedEvents.push({ event, siteId, data })
    return 1
  }

  /**
   * Since OpenProject #1923, `create`/`update`/`delete` above stand in for `models/comments.ts`'s real
   * methods — which now emit `comment:new`/`comment:edit`/`comment:delete` themselves (previously the
   * route's own job). These two helpers mirror that model's private `resolveAuthorName`/`emitEvent` so
   * the fakes keep matching real behavior, and the `emittedEvents` assertions below keep meaning what
   * they always meant: the full request cycle results in the right webhook payload.
   */
  async function resolveAuthorNameForTest(comment: {
    authorId: string | null
    guestName: string | null
  }): Promise<string> {
    if (comment.authorId) {
      const user = await getById(comment.authorId)
      if (user) {
        return user.name
      }
    }
    return comment.guestName ?? ''
  }

  async function emitCommentHook(
    event: 'comment:new' | 'comment:edit' | 'comment:delete',
    comment: {
      id: string
      pageId: string
      siteId: string
      authorId: string | null
      replyTo: string | null
      content: string
    },
    authorName?: string
  ): Promise<void> {
    const base = {
      id: comment.id,
      pageId: comment.pageId,
      siteId: comment.siteId,
      authorId: comment.authorId,
      isGuest: comment.authorId === null
    }
    await emit(
      event,
      comment.siteId,
      event === 'comment:delete'
        ? base
        : { ...base, metadata: { authorName, replyTo: comment.replyTo }, content: comment.content }
    )
  }

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      // -> OpenProject #935: the site-level `features.comments` flag POST now checks, defaulted on
      //    so every pre-existing test in this describe keeps passing unchanged.
      sites: { [SITE_ID]: { id: SITE_ID, config: { features: { comments: true } } } },
      // -> `limitGuestComments` (OpenProject #2256) logs a debug line when it refuses a request.
      logger: { debug: () => {} },
      models: {
        pages: { getPage },
        groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
        users: { getById },
        comments: {
          listForPage,
          create,
          get: getComment,
          update: updateComment,
          delete: deleteComment
        },
        hooks: { emit },
        rateLimits: { consume: consumeRateLimit }
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
    await registerErrorSchema(app)
    await registerCommentSchema(app)
    await registerCommentProviderSchema(app)
    await registerParamsSchemas(app)
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
    rateLimitVerdict = { allowed: true, hits: 1, retryAfter: 0 }
    rateLimitConsumeCalls.length = 0
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
    assert.equal(res.statusCode, 404)
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
      headers: { 'x-test-permissions': 'read:pages,read:comments' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.length, 1)
    assert.equal(body[0].id, EXISTING_COMMENT_ID)
    assert.equal(body[0].authorName, 'Alice')
    assert.equal(body[0].authorEmail, null)
  })

  test('POST create: 400 when anonymous and guestName/guestEmail are both missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
      headers: { 'x-test-permissions': 'read:pages,write:comments' },
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

  test('POST create: 400 when content exceeds the schema maxLength (schema-level check, before the handler runs)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
      headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
      payload: { content: 'a'.repeat(32769) }
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
      payload: {
        content: 'Hello from a guest',
        guestName: 'Casey',
        guestEmail: 'casey@example.com'
      }
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

  test('POST create: consumes the guest rate-limit bucket keyed by req.ip (OpenProject #2256)', async () => {
    await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
      headers: { 'x-test-permissions': 'read:pages,write:comments' },
      remoteAddress: '203.0.113.7',
      payload: {
        content: 'Hello from a guest',
        guestName: 'Casey',
        guestEmail: 'casey@example.com'
      }
    })
    assert.equal(rateLimitConsumeCalls.length, 1)
    assert.equal(rateLimitConsumeCalls[0].key, 'comment-guest:203.0.113.7')
  })

  test('POST create: 429 when the guest rate limit is exhausted, and the comment is not stored', async () => {
    rateLimitVerdict = { allowed: false, hits: 6, retryAfter: 120 }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
      headers: { 'x-test-permissions': 'read:pages,write:comments' },
      remoteAddress: '203.0.113.7',
      payload: {
        content: 'Hello from a guest',
        guestName: 'Casey',
        guestEmail: 'casey@example.com'
      }
    })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '120')
    assert.equal(created.length, 0)
  })

  test('POST create: an authenticated post is not subject to the guest rate limit', async () => {
    rateLimitVerdict = { allowed: false, hits: 6, retryAfter: 120 }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
      headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
      payload: { content: 'Hello from an account' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(rateLimitConsumeCalls.length, 0)
    assert.equal(created.length, 1)
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

  /**
   * OpenProject #935: a page saved with `allowComments: false`, or a site with `features.comments`
   * off, still accepted POST -- neither flag was checked anywhere but the client-side form.
   */
  test('POST create: 403 when the page itself has allowComments: false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${NO_COMMENTS_PAGE_ID}/comments`,
      headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
      payload: { content: 'Hello' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(created.length, 0)
  })

  test('POST create: 403 when the site has features.comments off', async () => {
    ;(globalThis as any).WIKI.sites[SITE_ID].config.features.comments = false
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'Hello' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(created.length, 0)
    } finally {
      ;(globalThis as any).WIKI.sites[SITE_ID].config.features.comments = true
    }
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
      const res = await send(
        `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${OTHER_PAGE_COMMENT_ID}`,
        {
          'x-test-user-id': 'author-1',
          'x-test-permissions': 'read:pages,read:comments'
        }
      )
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
    assert.equal(body.authorName, 'Alice')
    assert.equal(body.authorEmail, null)
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

  // -> WP 1691: PATCH's body schema is `CommentUpdateInput#`, not the POST-shaped `CommentInput#` --
  //    a `replyTo` (or `guestName`/`guestEmail`) field in the body must 400 rather than be silently
  //    ignored, since the handler only ever reads `content` off it.
  test('PATCH: 400 when the body includes replyTo instead of silently ignoring it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
      headers: { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' },
      payload: { content: 'Updated content', replyTo: EXISTING_COMMENT_ID }
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(updatedIds, [])
  })

  test('PATCH: 400 when the body includes guestName instead of silently ignoring it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`,
      headers: { 'x-test-user-id': 'author-1', 'x-test-permissions': 'read:pages,read:comments' },
      payload: { content: 'Updated content', guestName: 'Someone Else' }
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(updatedIds, [])
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
})
