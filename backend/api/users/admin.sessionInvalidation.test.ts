import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import {
  groups as groupsTable,
  sessions as sessionsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import groupsRoutes from '../groups.ts'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `session.groups`/`session.permissions` are snapshots taken at login, so a route that changes what
 * they should say has to clear the affected sessions -- and only those.
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

      // -> `setupTestDb()` leaves `config` empty and the group routes read `auth.rootAdminGroupId`
      //    unguarded. Both ids name a group nothing here uses, so neither guard ever engages.
      CARDINAL.config.auth = { rootAdminGroupId: '00000000-0000-0000-0000-000000000000' }
      CARDINAL.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }

      app = await buildTestApp({
        // -> Prefixed as `api/index.ts` mounts them: `PUT /:groupId` and `PUT /:userId` are the
        //    same route to Fastify's router when both plugins sit bare at '/'.
        routes: [
          { plugin: groupsRoutes, prefix: '/groups' },
          { plugin: usersRoutes, prefix: '/users' }
        ],
        ajv: true,
        // -> `manage:system` bypasses the other guards these routes carry (root-admin protection,
        //    the system-permission toggle guard), keeping the suite on the invalidation wiring.
        session: {
          authenticated: true,
          user: { id: fixtures.userId },
          groups: [],
          permissions: ['manage:system']
        }
      })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    beforeEach(async () => {
      await fixtures.db.delete(sessionsTable)
      // -> Several tests assign/unassign themselves, and a membership left by a preceding test
      //    would conflict with those.
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

    test('DELETE /:groupId clears sessions for every member (OpenProject #1719)', async () => {
      // -> A group of its own: every other test here still needs `fixtures.groupId` to exist.
      const [deletedGroup] = await fixtures.db
        .insert(groupsTable)
        .values({ name: 'Group To Delete', permissions: ['manage:navigation'], rules: [] })
        .returning({ id: groupsTable.id })
      await fixtures.db
        .insert(userGroupsTable)
        .values({ userId: secondUserId, groupId: deletedGroup!.id })
      await fixtures.db.insert(sessionsTable).values([
        { id: 'deleted-group-member-session', userId: secondUserId, data: {} },
        { id: 'unrelated-session', userId: fixtures.userId, data: {} }
      ])
      const res = await app.inject({
        method: 'DELETE',
        url: `/groups/${deletedGroup!.id}`
      })
      assert.equal(res.statusCode, 204)
      assert.deepEqual(await sessionIds(), ['unrelated-session'])
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
