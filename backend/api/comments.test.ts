import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import commentsRoutes from './comments.ts'
import { createSilentLogger } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('comment provider routes', () => {
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
    // -> The unknown-site 404 is `siteEnabledPreHandler`'s, not the route's, so a plugin-only app
    //    has to register it.
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(commentsRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      wiki: {
        sites,
        models: {
          commentProviders: { getSiteProviders, setActiveProvider }
        }
      }
    })
  })

  after(() => closeTestApp(app))

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

  let rateLimitVerdict = { allowed: true, hits: 1, retryAfter: 0 }
  // -> Separate verdicts, told apart by key prefix in `consumeRateLimit`, so a test can refuse the
  //    cooldown without tripping the guest-IP limiter, and vice versa.
  let cooldownVerdict = { allowed: true, hits: 1, retryAfter: 0 }
  const rateLimitConsumeCalls: { key: string; policy: any }[] = []

  async function consumeRateLimit(key: string, policy: any) {
    rateLimitConsumeCalls.push({ key, policy })
    return key.startsWith('comment-cooldown:') ? cooldownVerdict : rateLimitVerdict
  }

  /** `null` (no active provider) makes the route skip its spam check and cooldown entirely. */
  let activeProviderResult: {
    provider: { config: Record<string, any> }
    module: { checkSpam: (...args: any[]) => Promise<{ isSpam: boolean; reason?: string }> }
  } | null = null
  const checkSpamCalls: any[] = []

  async function activeProviderModule(_siteId: string) {
    return activeProviderResult
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
   * The real `models/comments.ts` methods emit `comment:new`/`comment:edit`/`comment:delete`
   * themselves, so the fakes above do too. These two helpers mirror that model's private
   * `resolveAuthorName`/`emitEvent` — keep them in sync.
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
    app = await buildTestApp({
      routes: commentsRoutes,
      ajv: true,
      // -> Its own two headers rather than the harness's `'header'` convention: the guest cases
      //    need an `authenticated: false` session PRESENT (not absent), the others a `user.id`.
      session: (req: any) => {
        const userId = req.headers['x-test-user-id'] as string | undefined
        const permissions = ((req.headers['x-test-permissions'] as string | undefined) ?? '')
          .split(',')
          .filter(Boolean)
        return userId
          ? { authenticated: true, user: { id: userId }, permissions }
          : { authenticated: false, permissions }
      },
      wiki: {
        sites: { [SITE_ID]: { id: SITE_ID, config: { features: { comments: true } } } },
        // -> `limitGuestComments` logs when it refuses a request.
        logger: createSilentLogger(),
        models: {
          pages: { getPage },
          groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
          users: { getById },
          comments: {
            listForPage,
            create,
            get: getComment,
            update: updateComment,
            delete: deleteComment,
            activeProviderModule
          },
          hooks: { emit },
          rateLimits: { consume: consumeRateLimit }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    created.length = 0
    commentsById = freshComments()
    updatedIds.length = 0
    deletedIds.length = 0
    emittedEvents.length = 0
    rateLimitVerdict = { allowed: true, hits: 1, retryAfter: 0 }
    cooldownVerdict = { allowed: true, hits: 1, retryAfter: 0 }
    rateLimitConsumeCalls.length = 0
    activeProviderResult = null
    checkSpamCalls.length = 0
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
      headers: { 'x-test-permissions': 'read:comments' }
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
    ;(globalThis as any).CARDINAL.sites[SITE_ID].config.features.comments = false
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
      ;(globalThis as any).CARDINAL.sites[SITE_ID].config.features.comments = true
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

  describe('POST create: native provider spam check and post-delay cooldown (WP #3377)', () => {
    test('400s when the configured Akismet key flags the content as spam', async () => {
      activeProviderResult = {
        provider: { config: { akismet: 'fake-key', minDelay: 0 } },
        module: {
          checkSpam: async (params: any, conf: any) => {
            checkSpamCalls.push({ params, conf })
            return { isSpam: true }
          }
        }
      }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'Buy cheap watches now' }
      })
      assert.equal(res.statusCode, 400)
      assert.equal(created.length, 0)
      assert.equal(checkSpamCalls.length, 1)
      assert.equal(checkSpamCalls[0].params.content, 'Buy cheap watches now')
      assert.equal(checkSpamCalls[0].params.role, 'user')
    })

    test('never calls checkSpam at all when no Akismet key is configured', async () => {
      activeProviderResult = {
        provider: { config: { akismet: '', minDelay: 0 } },
        module: { checkSpam: async () => ({ isSpam: true }) }
      }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'A normal comment' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(created.length, 1)
      assert.equal(checkSpamCalls.length, 0)
    })

    // -> The real `checkSpam` never throws: an unreachable or misconfigured Akismet fails open to
    //    `{ isSpam: false, reason }`. The route must not treat a present `reason` as a refusal.
    test('fails open: a checkSpam verdict of isSpam:false with a reason still lets the comment through', async () => {
      activeProviderResult = {
        provider: { config: { akismet: 'fake-key', minDelay: 0 } },
        module: {
          checkSpam: async () => ({
            isSpam: false,
            reason: 'Akismet check failed: request timed out'
          })
        }
      }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'A normal comment' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(created.length, 1)
    })

    test('429s a second post from the same account inside the configured minDelay', async () => {
      activeProviderResult = {
        provider: { config: { akismet: '', minDelay: 30 } },
        module: { checkSpam: async () => ({ isSpam: false }) }
      }
      cooldownVerdict = { allowed: false, hits: 2, retryAfter: 15 }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'Too soon' }
      })
      assert.equal(res.statusCode, 429)
      assert.equal(res.headers['retry-after'], '15')
      assert.equal(created.length, 0)
      const cooldownCall = rateLimitConsumeCalls.find((c) => c.key === 'comment-cooldown:user-1')
      assert.ok(cooldownCall, 'expected a comment-cooldown: consume call keyed by the account id')
      assert.equal(cooldownCall!.policy.max, 1)
      assert.equal(cooldownCall!.policy.windowSeconds, 30)
    })

    test('429s a second guest post inside minDelay, pooled onto the shared guests bucket', async () => {
      activeProviderResult = {
        provider: { config: { akismet: '', minDelay: 30 } },
        module: { checkSpam: async () => ({ isSpam: false }) }
      }
      cooldownVerdict = { allowed: false, hits: 2, retryAfter: 20 }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-permissions': 'read:pages,write:comments' },
        remoteAddress: '203.0.113.9',
        payload: { content: 'Too soon', guestName: 'Casey', guestEmail: 'casey@example.com' }
      })
      assert.equal(res.statusCode, 429)
      assert.equal(created.length, 0)
      const cooldownCall = rateLimitConsumeCalls.find((c) => c.key === 'comment-cooldown:guests')
      assert.ok(cooldownCall, 'expected the pooled guests bucket, not a per-IP key')
    })

    test('a moderator (manage:comments on the page) is exempt from the cooldown entirely', async () => {
      activeProviderResult = {
        provider: { config: { akismet: '', minDelay: 30 } },
        module: { checkSpam: async () => ({ isSpam: false }) }
      }
      // -> Would refuse if the cooldown were consulted at all.
      cooldownVerdict = { allowed: false, hits: 99, retryAfter: 999 }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: {
          'x-test-user-id': 'user-1',
          'x-test-permissions': 'read:pages,write:comments,manage:comments'
        },
        payload: { content: 'Moderator posting again immediately' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(created.length, 1)
      assert.equal(
        rateLimitConsumeCalls.some((c) => c.key.startsWith('comment-cooldown:')),
        false,
        'the cooldown must never even be consulted for an exempt moderator'
      )
    })

    test('minDelay: 0 (the "off" value) never consults the cooldown either', async () => {
      activeProviderResult = {
        provider: { config: { akismet: '', minDelay: 0 } },
        module: { checkSpam: async () => ({ isSpam: false }) }
      }
      cooldownVerdict = { allowed: false, hits: 99, retryAfter: 999 }
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}/comments`,
        headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:comments' },
        payload: { content: 'Posting again immediately, delay is off' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(created.length, 1)
    })
  })

  /**
   * PATCH and DELETE must apply the identical self-authorship rule (a comment's own author may act
   * without `manage:comments`), so the shared cases run against both.
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
      const res = await send(`/sites/${SITE_ID}/pages/${PAGE_ID}/comments/${EXISTING_COMMENT_ID}`, {
        'x-test-user-id': 'author-1',
        'x-test-permissions': 'read:comments'
      })
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
      // -> A guest comment's `authorId` is null, so self-authorship has nothing to match against.
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

    assert.equal(emittedEvents.length, 1)
    assert.equal(emittedEvents[0].event, 'comment:edit')
    assert.equal(emittedEvents[0].data.id, EXISTING_COMMENT_ID)
    assert.equal(emittedEvents[0].data.pageId, PAGE_ID)
    assert.equal(emittedEvents[0].data.siteId, SITE_ID)
    assert.equal(emittedEvents[0].data.authorId, 'author-1')
    assert.equal(emittedEvents[0].data.content, 'Updated content')
  })

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

    assert.equal(emittedEvents.length, 1)
    assert.equal(emittedEvents[0].event, 'comment:delete')
    assert.equal(emittedEvents[0].data.id, EXISTING_COMMENT_ID)
    assert.equal(emittedEvents[0].data.pageId, PAGE_ID)
    assert.equal(emittedEvents[0].data.siteId, SITE_ID)
  })
})
