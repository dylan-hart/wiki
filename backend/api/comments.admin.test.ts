import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  comments as commentsTable,
  groups as groupsTable,
  hooks as hooksTable
} from '../db/schema.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import commentsRoutes from './comments.ts'
import { registerSchemas as registerCommentSchema } from './schemas/comment.ts'
import { registerSchemas as registerCommentProviderSchema } from './schemas/commentProvider.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import { registerParamsSchemas } from './schemas/params.ts'

/**
 * DB-backed route test for `GET/DELETE /sites/:siteId/comments` (Task 625, Feature 394).
 *
 * The whole point of this task is that `manage:comments` is decided PER PAGE, individually, against
 * the real rule-matching in `helpers/pageRules.ts` — a test that stubs `WIKI.models.groups.checkAccess`
 * would only prove the route calls a function, not that the scoping actually works. This suite runs
 * the real routes, the real `groups`/`pages`/`comments` models and a real, migrated database (see
 * `test/db.ts`) — `models/comments.test.ts` covers `listForAdmin`'s own filters and pagination in
 * isolation; this file covers the permission boundary around it.
 *
 * There is no real session plugin here (`@fastify/session` needs a cookie round trip this suite has
 * no reason to exercise) — `req.session` is set directly by an `onRequest` hook from a
 * per-test-mutable `testSession` variable, which is all `WIKI.models.groups.actorForRequest` reads.
 */
describe('GET/DELETE /sites/:siteId/comments (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let app: FastifyInstance
  let groupsModel: typeof import('../models/groups.ts').groups
  let pagesModel: typeof import('../models/pages.ts').pages
  let commentsModel: typeof import('../models/comments.ts').comments
  let testSession: any = null
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('../models/groups.ts'))
    ;({ pages: pagesModel } = await import('../models/pages.ts'))
    ;({ comments: commentsModel } = await import('../models/comments.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    app = fastify()
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = testSession
    })
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
    await teardownTestDb()
  })

  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['manage:comments'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  async function setGroupRules(rules: GroupRule[]): Promise<void> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  }

  test('GET 404s for a site that does not exist', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: []
    }
    const res = await app.inject({
      method: 'GET',
      url: '/sites/00000000-0000-0000-0000-000000000000/comments'
    })
    assert.equal(res.statusCode, 404)
  })

  test('a comment only appears when the actor holds manage:comments on ITS page, individually', async () => {
    const teamA = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scope-team-a/notes', title: 'Team A', editor: 'markdown', content: 'x' },
      actor
    )
    const teamB = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scope-team-b/notes', title: 'Team B', editor: 'markdown', content: 'x' },
      actor
    )

    const [commentA] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: teamA.id, content: 'On team A' })
      .returning()
    const [commentB] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: teamB.id, content: 'On team B' })
      .returning()

    // -> Grants `manage:comments` on `scope-team-a` only — NOT `scope-team-b`.
    await setGroupRules([rule({ path: 'scope-team-a' })])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }

    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/comments` })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    const ids = body.results.map((c: any) => c.id)
    assert.ok(ids.includes(commentA!.id))
    assert.ok(!ids.includes(commentB!.id))

    // -> DELETE on the accessible page succeeds...
    const deleteA = await app.inject({
      method: 'DELETE',
      url: `/sites/${fixtures.siteId}/comments/${commentA!.id}`
    })
    assert.equal(deleteA.statusCode, 204)
    assert.equal(await commentsModel.getWithPage(commentA!.id), null)

    // -> ...but the same actor cannot delete the one on the page their rule does not cover.
    const deleteB = await app.inject({
      method: 'DELETE',
      url: `/sites/${fixtures.siteId}/comments/${commentB!.id}`
    })
    assert.equal(deleteB.statusCode, 403)
    assert.ok(await commentsModel.getWithPage(commentB!.id))
  })

  test('manage:system sees every page, bypassing rule evaluation entirely', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scope-admin-only/notes', title: 'Admin Only', editor: 'markdown', content: 'x' },
      actor
    )
    const [comment] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: page.id, content: 'Visible to admins' })
      .returning()

    // -> No rule grants anything at all.
    await setGroupRules([])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }

    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/comments` })
    assert.equal(res.statusCode, 200)
    const ids = res.json().results.map((c: any) => c.id)
    assert.ok(ids.includes(comment!.id))
  })

  test('manage:system never materialises the site-wide page-id list, and still returns the same rows', async () => {
    const teamA = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'skip-materialise/team-a', title: 'Team A', editor: 'markdown', content: 'x' },
      actor
    )
    const teamB = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'skip-materialise/team-b', title: 'Team B', editor: 'markdown', content: 'x' },
      actor
    )
    const [commentA] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: teamA.id, content: 'On team A' })
      .returning()
    const [commentB] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: teamB.id, content: 'On team B' })
      .returning()

    // -> No rule grants anything at all — proves the rows below come from the `manage:system`
    // short-circuit, not from a rule matching every page.
    await setGroupRules([])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }

    // `pageRefsForSite` is the only source of the page-id list `listForAdmin`'s `IN (...)` would be
    // built from. A `manage:system` actor should never even call it — that's what "emits no `IN`
    // list" means at this layer: there is no page-id array to bind into one in the first place.
    const pageRefsSpy = mock.method(commentsModel, 'pageRefsForSite')
    try {
      const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/comments` })
      assert.equal(res.statusCode, 200)
      assert.equal(pageRefsSpy.mock.calls.length, 0)

      const ids = res.json().results.map((c: any) => c.id)
      assert.ok(ids.includes(commentA!.id))
      assert.ok(ids.includes(commentB!.id))
    } finally {
      pageRefsSpy.mock.restore()
    }
  })

  test('an actor with no matching rule at all gets an empty, not a 403', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scope-nobody/notes', title: 'Nobody', editor: 'markdown', content: 'x' },
      actor
    )
    await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: page.id, content: 'Nobody can see this' })

    await setGroupRules([])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }

    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/comments` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { results: [], totalHits: 0 })
  })

  test('DELETE 404s for a comment id that does not exist', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      permissions: ['manage:system']
    }
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${fixtures.siteId}/comments/00000000-0000-0000-0000-000000000000`
    })
    assert.equal(res.statusCode, 404)
  })

  /**
   * OpenProject #935: the page-scoped DELETE already emitted `comment:delete` (queuing a webhook
   * delivery); this site-wide moderation DELETE did not, so a subscriber mirroring comments missed
   * every deletion done from the admin moderation screen. Asserted through a REAL subscribed hook
   * row and the real `WIKI.scheduler.addJob` `mock.fn()` (`test/mocks.ts`'s `createSchedulerStub()`)
   * rather than a stub of `emit()` itself, so this proves the full `models/hooks.ts` queuing path
   * actually ran, not just that some function was called.
   */
  test('DELETE via the site-wide moderation route queues a comment:delete webhook delivery', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scope-webhook/notes', title: 'Webhook Scope', editor: 'markdown', content: 'x' },
      actor
    )
    const [comment] = await fixtures.db
      .insert(commentsTable)
      .values({ siteId: fixtures.siteId, pageId: page.id, content: 'Subject to a webhook' })
      .returning()

    await fixtures.db.insert(hooksTable).values({
      name: 'Comment mirror',
      events: ['comment:delete'],
      url: 'https://example.com/webhook',
      siteId: fixtures.siteId
    })

    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      permissions: ['manage:system']
    }
    const addJobCallsBefore = (WIKI.scheduler.addJob as any).mock.calls.length

    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${fixtures.siteId}/comments/${comment!.id}`
    })
    assert.equal(res.statusCode, 204)

    const newCalls = (WIKI.scheduler.addJob as any).mock.calls.slice(addJobCallsBefore)
    assert.equal(newCalls.length, 1)
    const queuedPayload = newCalls[0].arguments[0]
    assert.equal(queuedPayload.task, 'dispatchWebhook')
    assert.equal(queuedPayload.payload.event, 'comment:delete')
    assert.equal(queuedPayload.payload.data.id, comment!.id)
    assert.equal(queuedPayload.payload.data.pageId, page.id)
  })
})
