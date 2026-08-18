import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { comments as commentsTable, groups as groupsTable } from '../db/schema.ts'
import commentsRoutes from './comments.ts'
import { registerSchemas as registerCommentSchema } from './schemas/comment.ts'
import { registerSchemas as registerCommentProviderSchema } from './schemas/commentProvider.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'

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
    await registerCommentSchema(app)
    await registerCommentProviderSchema(app)
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
})
