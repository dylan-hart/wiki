import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  sessions as sessionsTable,
  users as usersTable,
  userGroups as userGroupsTable
} from '../db/schema.ts'

/**
 * OpenProject #2172: `signer` reads `WIKI.config.auth.secret` fresh on every sign/unsign call rather
 * than a value captured once at @fastify/cookie/@fastify/session registration (`index.ts`) -- this
 * is exactly the "no restart" behavior the FIXME it replaces used to be missing. Pure unit test: no
 * database, no Fastify server, just the signer object and a `WIKI.config.auth.secret` swapped out
 * mid-test the way `core/config.ts#subscribeToEvents`'s `reloadConfig` handler does it for real.
 */
describe('sessions model signer (pure)', () => {
  let originalWiki: any

  beforeEach(() => {
    originalWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { config: { auth: { secret: 'a'.repeat(32) } } }
  })

  afterEach(() => {
    ;(globalThis as any).WIKI = originalWiki
  })

  test('a value signed under the current secret unsigns valid under that same secret', async () => {
    const { sessions } = await import('./sessions.ts')
    const signed = sessions.signer.sign('cookie-value')
    const result = sessions.signer.unsign(signed)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'cookie-value')
  })

  test('a cookie signed before rotateSecret() no longer unsigns once reloadConfig delivers the new secret, with no restart', async () => {
    const { sessions } = await import('./sessions.ts')
    const signedBeforeRotation = sessions.signer.sign('cookie-value')

    // -> What `core/config.ts#subscribeToEvents`'s `reloadConfig` handler does on every instance --
    //    including this one, on its next call -- once `models/sessions.ts#rotateSecret()` saves the
    //    new secret: refresh `WIKI.config` from the DB. No plugin re-registration, no restart.
    WIKI.config.auth.secret = 'b'.repeat(32)

    const resultAfterRotation = sessions.signer.unsign(signedBeforeRotation)
    assert.equal(resultAfterRotation.valid, false)
  })

  test('a cookie minted after the secret rotates verifies under the new secret', async () => {
    const { sessions } = await import('./sessions.ts')
    WIKI.config.auth.secret = 'c'.repeat(32)

    const signedAfterRotation = sessions.signer.sign('post-rotation-value')
    const result = sessions.signer.unsign(signedAfterRotation)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'post-rotation-value')

    // -> And the OLD secret no longer verifies it, confirming this isn't accepting on either secret.
    WIKI.config.auth.secret = 'a'.repeat(32)
    assert.equal(sessions.signer.unsign(signedAfterRotation).valid, false)
  })
})

/**
 * OpenProject #936: `session.groups`/`session.permissions` are snapshots taken at login and
 * otherwise live for up to the 30-day cookie age -- `clearSessionsFromUser` existed with zero
 * callers, and `clearSessionsForGroup` is new here, both wired into the deactivation /
 * group-membership / group-permission-change routes in `api/users.ts` and `api/groups.ts`. This is
 * the SQL orchestration itself (a delete, and a delete filtered by a membership lookup) -- exactly
 * the DB-backed case CLAUDE.md's Testing section carves out from the pure-unit default.
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
})
