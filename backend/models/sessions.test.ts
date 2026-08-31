import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { and, eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  sessions as sessionsTable,
  users as usersTable,
  userGroups as userGroupsTable
} from '../db/schema.ts'

/**
 * OpenProject #936: `session.groups`/`session.permissions` are snapshots taken at login and
 * otherwise live for up to the 30-day cookie age -- `clearSessionsFromUser` existed with zero
 * callers, and `clearSessionsForGroup` is new here, both wired into the deactivation /
 * group-membership / group-permission-change routes in `api/users.ts` and `api/groups.ts`.
 *
 * OpenProject #2248: `purgeExpiredSessions` is the same table's housekeeping counterpart --
 * `@fastify/session` never calls `store.destroy` on a stale row, so a row past the cookie's 30-day
 * window is otherwise never revisited on its own.
 *
 * This is the SQL orchestration itself (deletes, one filtered by a membership lookup, one by an age
 * predicate) -- exactly the DB-backed case CLAUDE.md's Testing section carves out from the pure-unit
 * default.
 */
describe('sessions model (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sessionsModel: typeof import('./sessions.ts').sessions
  let secondUserId: string
  let secondGroupId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ sessions: sessionsModel } = await import('./sessions.ts'))

    const [secondUser] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'second-member@example.com', name: 'Second Member', isActive: true })
      .returning({ id: usersTable.id })
    secondUserId = secondUser!.id

    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'Second Fixture Group', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    secondGroupId = secondGroup!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  async function seedSession(id: string, userId: string): Promise<void> {
    await fixtures.db.insert(sessionsTable).values({ id, userId, data: { user: { id: userId } } })
  }

  beforeEach(async () => {
    await fixtures.db.delete(sessionsTable)
    await fixtures.db.delete(userGroupsTable)
  })

  test('clearSessionsFromUser deletes every session for that user only', async () => {
    await seedSession('session-a', fixtures.userId)
    await seedSession('session-b', fixtures.userId)
    await seedSession('session-c', secondUserId)

    const result = await sessionsModel.clearSessionsFromUser(fixtures.userId)
    assert.equal(result.rowCount, 2)

    const remaining = await fixtures.db.select().from(sessionsTable)
    assert.deepEqual(
      remaining.map((r) => r.id),
      ['session-c']
    )
  })

  test('clearSessionsFromUser is a no-op, not an error, when the user has no sessions', async () => {
    const result = await sessionsModel.clearSessionsFromUser(fixtures.userId)
    assert.equal(result.rowCount, 0)
  })

  test('clearSessionsForGroup deletes sessions for every CURRENT member, and nobody else', async () => {
    await fixtures.db.insert(userGroupsTable).values([
      { userId: fixtures.userId, groupId: secondGroupId },
      { userId: secondUserId, groupId: secondGroupId }
    ])

    // -> A third user with a session, but no membership in the group being cleared.
    const [thirdUser] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'unrelated@example.com', name: 'Unrelated', isActive: true })
      .returning({ id: usersTable.id })

    await seedSession('member-a-session', fixtures.userId)
    await seedSession('member-b-session', secondUserId)
    await seedSession('unrelated-session', thirdUser!.id)

    const ended = await sessionsModel.clearSessionsForGroup(secondGroupId)
    assert.equal(ended, 2)

    const remaining = await fixtures.db.select().from(sessionsTable)
    assert.deepEqual(
      remaining.map((r) => r.id),
      ['unrelated-session']
    )
  })

  test('clearSessionsForGroup returns 0 and touches nothing for a group with no members', async () => {
    await seedSession('lone-session', fixtures.userId)

    const ended = await sessionsModel.clearSessionsForGroup(secondGroupId)
    assert.equal(ended, 0)

    const remaining = await fixtures.db.select().from(sessionsTable)
    assert.equal(remaining.length, 1)
  })

  test("clearSessionsForGroup does not touch a former member's session, after they left", async () => {
    await fixtures.db
      .insert(userGroupsTable)
      .values({ userId: fixtures.userId, groupId: secondGroupId })
    await seedSession('leaver-session', fixtures.userId)

    await fixtures.db
      .delete(userGroupsTable)
      .where(
        and(eq(userGroupsTable.userId, fixtures.userId), eq(userGroupsTable.groupId, secondGroupId))
      )

    const ended = await sessionsModel.clearSessionsForGroup(secondGroupId)
    assert.equal(ended, 0)
    assert.equal((await fixtures.db.select().from(sessionsTable)).length, 1)
  })

  test('purgeExpiredSessions deletes only rows past the 30-day cookie window', async () => {
    await fixtures.db.insert(sessionsTable).values([
      {
        id: 'stale-session',
        userId: fixtures.userId,
        data: { user: { id: fixtures.userId } },
        updatedAt: sql`now() - interval '31 days'`
      },
      {
        id: 'fresh-session',
        userId: fixtures.userId,
        data: { user: { id: fixtures.userId } },
        updatedAt: sql`now() - interval '1 day'`
      }
    ] as any)

    const purged = await sessionsModel.purgeExpiredSessions()
    assert.equal(purged, 1)

    const remaining = await fixtures.db.select().from(sessionsTable)
    assert.deepEqual(
      remaining.map((r) => r.id),
      ['fresh-session']
    )
  })

  test('purgeExpiredSessions returns 0 and touches nothing when every row is within the window', async () => {
    await seedSession('fresh-session', fixtures.userId)

    const purged = await sessionsModel.purgeExpiredSessions()
    assert.equal(purged, 0)
    assert.equal((await fixtures.db.select().from(sessionsTable)).length, 1)
  })
})
