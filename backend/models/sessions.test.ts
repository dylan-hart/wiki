import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { and, eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  sessions as sessionsTable,
  users as usersTable,
  userGroups as userGroupsTable
} from '../db/schema.ts'
import { authSecretSigner } from '../helpers/authSecretSigner.ts'
import configSvc from '../core/config.ts'
import { sessionStoreAdapter } from './sessions.ts'

/**
 * OpenProject #936: `session.groups`/`session.permissions` are snapshots taken at login and
 * otherwise live for up to the 30-day cookie age -- `clearSessionsFromUser` existed with zero
 * callers, and `clearSessionsForGroup` is new here, both wired into the deactivation /
 * group-membership / group-permission-change routes in `api/users/admin.ts` and `api/groups.ts`.
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
    // -> Not part of the minimal `installTestWiki()` fixture (`test/db.ts`) — added here because
    //    `rotateSecret()` below is the one model method that needs it, via `saveToDb()`. The real
    //    module, not a stub: it upserts through `WIKI.models.settings.updateConfig`, which works fine
    //    unseeded against this suite's own fresh schema.
    WIKI.configSvc = configSvc
    WIKI.config.auth = { secret: 'fixture-initial-secret-value' }

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

  /**
   * OpenProject #2172: a cookie signed before `rotateSecret()` must stop unsigning right after it
   * runs, with no restart -- the real regression this whole mechanism exists to close (the old
   * `index.ts` FIXME this task removed). `helpers/authSecretSigner.test.ts` covers the signer's
   * read-fresh-per-call mechanism in isolation, with no DB; this is the round trip through the real
   * model method, which is also what actually swaps `WIKI.config.auth.secret` here.
   */
  test('rotateSecret invalidates already-signed cookies immediately, and new ones verify under the new secret', async () => {
    const signedBeforeRotation = authSecretSigner.sign('session-before-rotation')
    assert.equal(authSecretSigner.unsign(signedBeforeRotation).valid, true)

    const ended = await sessionsModel.rotateSecret()
    assert.notEqual(ended, null)

    assert.equal(
      authSecretSigner.unsign(signedBeforeRotation).valid,
      false,
      'a cookie signed under the pre-rotation secret must not still unsign'
    )

    const signedAfterRotation = authSecretSigner.sign('session-after-rotation')
    const result = authSecretSigner.unsign(signedAfterRotation)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'session-after-rotation')
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

/**
 * The @fastify/session store adapter (CORE-F12): three copies of the same
 * `try { clb(null, await …) } catch (err) { clb(err, null) }` wrapper, written out inline in
 * `index.ts` until they collapsed onto one `settle()` here. No database — what is under test is the
 * promise-to-callback translation, including the rejection path, which nothing exercised before.
 */
describe('sessionStoreAdapter', () => {
  let previousWiki: any

  /** Installs a `WIKI.models.sessions` whose three methods are whatever this test needs. */
  function installSessionsModel(stub: Record<string, (...args: any[]) => Promise<any>>) {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { models: { sessions: stub } }
  }

  afterEach(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('get resolves through the callback as (null, result)', async () => {
    installSessionsModel({ get: async (id: string) => ({ id, user: { id: 'u1' } }) })
    const calls: any[] = []
    await sessionStoreAdapter().get('sess-1', (err, result) => calls.push([err, result]))
    assert.deepEqual(calls, [[null, { id: 'sess-1', user: { id: 'u1' } }]])
  })

  test('set passes both the id and the session data through, and reports (null, undefined)', async () => {
    const seen: any[] = []
    installSessionsModel({
      set: async (id: string, data: any) => {
        seen.push([id, data])
      }
    })
    const calls: any[] = []
    await sessionStoreAdapter().set('sess-1', { user: { id: 'u1' } }, (err, result) =>
      calls.push([err, result])
    )
    assert.deepEqual(seen, [['sess-1', { user: { id: 'u1' } }]])
    assert.deepEqual(calls, [[null, undefined]])
  })

  test('destroy resolves through the callback', async () => {
    const seen: string[] = []
    installSessionsModel({
      destroy: async (id: string) => {
        seen.push(id)
        return { rowCount: 1 }
      }
    })
    const calls: any[] = []
    await sessionStoreAdapter().destroy('sess-1', (err, result) => calls.push([err, result]))
    assert.deepEqual(seen, ['sess-1'])
    assert.deepEqual(calls, [[null, { rowCount: 1 }]])
  })

  test('a rejection is reported as (err, null) rather than escaping the store', async () => {
    const boom = new Error('connection terminated')
    installSessionsModel({
      get: async () => {
        throw boom
      }
    })
    const calls: any[] = []
    await sessionStoreAdapter().get('sess-1', (err, result) => calls.push([err, result]))
    assert.deepEqual(calls, [[boom, null]])
  })

  test('a synchronous throw is reported the same way, not left unhandled', async () => {
    const boom = new Error('no database')
    installSessionsModel({
      destroy: () => {
        throw boom
      }
    })
    const calls: any[] = []
    await sessionStoreAdapter().destroy('sess-1', (err, result) => calls.push([err, result]))
    assert.deepEqual(calls, [[boom, null]])
  })
})
