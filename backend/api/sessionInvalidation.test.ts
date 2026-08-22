import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  sessions as sessionsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import groupsRoutes from './groups.ts'
import usersRoutes from './users.ts'
import { registerSchemas as registerGroupSchema } from './schemas/group.ts'
import { registerSchemas as registerUserSchema } from './schemas/user.ts'
import { registerSchemas as registerApiKeySchema } from './schemas/apiKey.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * OpenProject #936: `session.groups`/`session.permissions` are snapshots taken at login, otherwise
 * live for up to the 30-day cookie age. `clearSessionsFromUser`/`clearSessionsForGroup`
 * (`models/sessions.ts`, covered on their own in `models/sessions.test.ts`) are now wired into the
 * three routes that change what a session's snapshot should say — this file proves the WIRING: that
 * each route actually calls through at the right moment, with the right target, and does NOT call
 * through when nothing session-relevant changed. Real routes, a real DB, real `groups`/`users`/
 * `sessions` models -- there is no permission-checking `preHandler` hook in this bare app (that lives
 * in `index.ts`, exercised by nothing here), so a simulated admin session is set directly for every
 * request, the same way `api/comments.admin.test.ts` does.
 */
describe(
  'session invalidation wiring on deactivation / group-membership / group-permission routes (task #936, DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let app: FastifyInstance
    let secondUserId: string

    async function seedSession(id: string, userId: string): Promise<void> {
      await fixtures.db.insert(sessionsTable).values({ id, userId, data: { user: { id: userId } } })
    }

    async function sessionIds(): Promise<string[]> {
      return (await fixtures.db.select().from(sessionsTable)).map((r) => r.id)
    }

    before(async () => {
      fixtures = await setupTestDb()

      const [secondUser] = await fixtures.db
        .insert(usersTable)
        .values({ email: 'second-member@example.com', name: 'Second Member', isActive: true })
        .returning({ id: usersTable.id })
      secondUserId = secondUser!.id

      // -> `groups.ts` reads `WIKI.config.auth.rootAdminGroupId` (root-admin-group protection) --
      //    `setupTestDb()`'s minimal WIKI leaves `config` empty, so this must be set for the routes
      //    under test to even boot past that read. Pointed at a group nothing here uses, so it never
      //    actually engages that guard.
      WIKI.config.auth = { rootAdminGroupId: '00000000-0000-0000-0000-000000000000' }
      // -> `updateGroup()`'s `clampGuestPatch()` reads `WIKI.data.systemIds.guestsGroupId` on every
      //    call, not just for the guests group -- same reasoning as `rootAdminGroupId` above.
      WIKI.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }

      app = fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
      await app.register(fastifySensible)
      app.setErrorHandler((error: any, req, reply) => {
        reply.code(error.statusCode ?? 500).send({
          ok: false,
          error: error.name,
          statusCode: error.statusCode ?? 500,
          message: error.message
        })
      })
      await registerErrorSchema(app)
      await registerGroupSchema(app)
      await registerUserSchema(app)
      await registerApiKeySchema(app)
      // -> Simulates an authenticated manage:system admin on every request -- the routes under test
      //    read `req.session` directly (`actorFromRequest`, `holdsSystemPermission`,
      //    `groups.actorForRequest`), and manage:system is what bypasses every internal guard these
      //    routes also carry (root-admin protection, system-permission toggle guard, ...), keeping this
      //    suite focused on the session-invalidation wiring rather than re-proving those guards.
      app.addHook('onRequest', async (req) => {
        ;(req as any).session = {
          authenticated: true,
          user: { id: fixtures.userId },
          groups: [],
          permissions: ['manage:system']
        }
      })
      // -> Prefixed the same way `api/index.ts` registers them for real: both plugins declare
      //    same-shaped root params (`PUT /:groupId` / `PUT /:userId`), which collide as literally the
      //    same route to Fastify's router when mounted bare at '/' side by side.
      await app.register(groupsRoutes, { prefix: '/groups' })
      await app.register(usersRoutes, { prefix: '/users' })
      await app.ready()
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    beforeEach(async () => {
      await fixtures.db.delete(sessionsTable)
      // -> `setupTestDb()` seeds `fixtures.groupId` but assigns nobody to it -- each test starts
      //    from no memberships at all (several tests exercise assign/unassign themselves, so a
      //    membership left over from a PRECEDING test would otherwise conflict with those).
      await fixtures.db.delete(userGroupsTable)
    })

    test('PUT /:groupId clears sessions for every member when permissions change', async () => {
      await fixtures.db
        .insert(userGroupsTable)
        .values({ userId: fixtures.userId, groupId: fixtures.groupId })
      await fixtures.db.insert(sessionsTable).values([
        { id: 'member-session', userId: fixtures.userId, data: {} },
        { id: 'unrelated-session', userId: secondUserId, data: {} }
      ])
      // -> fixtures.userId is now a member of fixtures.groupId; secondUserId is not, so its session
      //    must survive.
      const res = await app.inject({
        method: 'PUT',
        url: `/groups/${fixtures.groupId}`,
        payload: { permissions: ['manage:navigation'] }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['unrelated-session'])
    })

    test('PUT /:groupId does NOT clear sessions when only rules (not permissions) change', async () => {
      await seedSession('member-session', fixtures.userId)
      const res = await app.inject({
        method: 'PUT',
        url: `/groups/${fixtures.groupId}`,
        payload: { rules: [] }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['member-session'])
    })

    test('PUT /:groupId does NOT clear sessions when only name changes', async () => {
      await seedSession('member-session', fixtures.userId)
      const res = await app.inject({
        method: 'PUT',
        url: `/groups/${fixtures.groupId}`,
        payload: { name: 'Renamed Group' }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['member-session'])
    })

    test('POST /:groupId/users/:userId (assign) clears only the newly-assigned user’s sessions', async () => {
      await fixtures.db.insert(sessionsTable).values([
        { id: 'assignee-session', userId: secondUserId, data: {} },
        { id: 'other-session', userId: fixtures.userId, data: {} }
      ])
      const res = await app.inject({
        method: 'POST',
        url: `/groups/${fixtures.groupId}/users/${secondUserId}`
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['other-session'])
    })

    test('DELETE /:groupId/users/:userId (unassign) clears only the removed user’s sessions', async () => {
      // -> Must actually be a member first, or the route 404s before reaching unassignUserFromGroup.
      const assign = await app.inject({
        method: 'POST',
        url: `/groups/${fixtures.groupId}/users/${secondUserId}`
      })
      assert.equal(assign.statusCode, 200)

      await fixtures.db.insert(sessionsTable).values([
        { id: 'leaver-session', userId: secondUserId, data: {} },
        { id: 'other-session', userId: fixtures.userId, data: {} }
      ])
      const res = await app.inject({
        method: 'DELETE',
        url: `/groups/${fixtures.groupId}/users/${secondUserId}`
      })
      assert.equal(res.statusCode, 204)
      assert.deepEqual(await sessionIds(), ['other-session'])
    })

    test('PUT /:userId (deactivation) clears that user’s sessions', async () => {
      await fixtures.db.insert(sessionsTable).values([
        { id: 'deactivated-session', userId: secondUserId, data: {} },
        { id: 'other-session', userId: fixtures.userId, data: {} }
      ])
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${secondUserId}`,
        payload: { isActive: false }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['other-session'])
    })

    test('PUT /:userId with a groups patch clears that user’s sessions', async () => {
      await seedSession('member-session', secondUserId)
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${secondUserId}`,
        payload: { groups: [fixtures.groupId] }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), [])
    })

    test('PUT /:userId does NOT clear sessions for an unrelated field change (name)', async () => {
      await seedSession('member-session', secondUserId)
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${secondUserId}`,
        payload: { name: 'Renamed User' }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['member-session'])
    })

    test('PUT /:userId with isActive: true (re-activation) does NOT clear sessions', async () => {
      await seedSession('member-session', secondUserId)
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${secondUserId}`,
        payload: { isActive: true }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(await sessionIds(), ['member-session'])
    })
  }
)
