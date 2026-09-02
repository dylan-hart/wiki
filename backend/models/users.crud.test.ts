import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { userCredentials } from './userCredentials.ts'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  pageEditSubmissions as pageEditSubmissionsTable,
  pages as pagesTable,
  sessions as sessionsTable,
  userAvatars,
  userGroups as userGroupsTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'

/**
 * One schema for the whole file rather than one per describe (TEST-F14): every `setupTestDb()` call
 * is a `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same
 * fixture. Anything a describe needs on top of that stays in its own `before()`.
 */
let fixtures: TestFixtures

before(async () => {
  fixtures = await setupTestDb()
})

after(async () => {
  await teardownTestDb()
})

/**
 * `reassignContent` is SQL orchestration over two tables inside one transaction — exactly the
 * `models/pages.test.ts`-style case CLAUDE.md calls out for a real database rather than a query
 * builder mock. Pages and assets are seeded with raw inserts (bypassing `pages.createPage()`/the
 * asset upload path entirely) since only the `authorId`/`creatorId`/`ownerId` columns this method
 * touches matter here.
 */
describe('users.reassignContent (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users
  let targetUserId: string

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))

    const [target] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'target@example.com',
        name: 'Target User',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    targetUserId = target!.id
  })

  function rawPageRow(overrides: {
    path: string
    authorId: string
    creatorId: string
    ownerId: string
  }) {
    return {
      locale: 'en',
      path: overrides.path,
      hash: `reassign-hash-${overrides.path}`,
      title: 'Reassign Me',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: overrides.authorId,
      creatorId: overrides.creatorId,
      ownerId: overrides.ownerId,
      siteId: fixtures.siteId,
      classification: fixtures.classificationId
    }
  }

  function rawAssetRow(overrides: { fileName: string; authorId: string }) {
    return {
      fileName: overrides.fileName,
      fileExt: 'png',
      authorId: overrides.authorId,
      siteId: fixtures.siteId
    }
  }

  test('reassigns a page that names the departing user in only one of authorId/creatorId/ownerId', async () => {
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/single-column',
          authorId: fixtures.userId,
          creatorId: targetUserId,
          ownerId: targetUserId
        })
      )
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.pagesReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, page!.id))
    assert.equal(reloaded!.authorId, targetUserId)
    assert.equal(reloaded!.creatorId, targetUserId)
    assert.equal(reloaded!.ownerId, targetUserId)
  })

  test('reassigns a page naming the departing user in all three columns, counted once', async () => {
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/all-columns',
          authorId: fixtures.userId,
          creatorId: fixtures.userId,
          ownerId: fixtures.userId
        })
      )
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.pagesReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, page!.id))
    assert.equal(reloaded!.authorId, targetUserId)
    assert.equal(reloaded!.creatorId, targetUserId)
    assert.equal(reloaded!.ownerId, targetUserId)
  })

  test('does not touch a page that never named the departing user', async () => {
    const [untouched] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/untouched',
          authorId: targetUserId,
          creatorId: targetUserId,
          ownerId: targetUserId
        })
      )
      .returning()

    await usersModel.reassignContent(fixtures.userId, targetUserId)

    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, untouched!.id))
    assert.equal(reloaded!.authorId, targetUserId)
  })

  test('reassigns every asset the departing user authored', async () => {
    const [asset] = await fixtures.db
      .insert(assetsTable)
      .values(rawAssetRow({ fileName: 'reassign-me.png', authorId: fixtures.userId }))
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.assetsReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset!.id))
    assert.equal(reloaded!.authorId, targetUserId)
  })

  test('reports zero for both counts when the departing user owns nothing', async () => {
    const [freshUser] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'nothing-owned@example.com',
        name: 'Nothing Owned',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })

    const result = await usersModel.reassignContent(freshUser!.id, targetUserId)

    assert.deepEqual(result, { pagesReassigned: 0, assetsReassigned: 0 })
  })
})

/**
 * `createUser()` atomicity (OpenProject #1607 / #1584): the insert and its group assignment now
 * share one `WIKI.db.transaction()`, so a failure in `setUserGroups` after the insert must leave no
 * orphaned user row behind, and the ordinary path must still land both.
 */
describe('users.createUser atomicity (DB-backed)', { skip: !hasTestDatabase() }, () => {
  before(async () => {
    // -> Matches `login.forgotPassword / resetPassword`'s own `createLocalUser` helper above: nothing
    //    under test here logs in, so this needs no matching `authentication` row, just a key for
    //    `createUser()` to store the password hash under.
    WIKI.data.systemIds = { localAuthId: 'atomic-create-test-strategy' } as any
  })

  test('rolls back the user insert when group assignment fails', async (t) => {
    t.mock.method(users, 'setUserGroups', async () => {
      throw new Error('simulated group-assignment failure')
    })

    await assert.rejects(
      users.createUser({
        name: 'Rollback Test',
        email: 'rollback-atomic@example.com',
        password: 'a-long-password',
        groups: [fixtures.groupId],
        isVerified: true
      }),
      /simulated group-assignment failure/
    )

    const rows = await fixtures.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, 'rollback-atomic@example.com'))
    assert.equal(rows.length, 0)
  })

  test('the ordinary create path lands both the user row and its group memberships', async () => {
    const userId = await users.createUser({
      name: 'Ordinary Create',
      email: 'ordinary-atomic@example.com',
      password: 'a-long-password',
      groups: [fixtures.groupId],
      isVerified: true
    })

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
    assert.ok(row)
    assert.equal(row!.email, 'ordinary-atomic@example.com')

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, userId))
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0]!.groupId, fixtures.groupId)
  })
})

/**
 * OpenProject #1742 (part of #1730): `setUserGroups` used to run its delete-then-insert as two
 * separate statements on the default connection with no transaction. `userGroups`' primary key is
 * `(userId, groupId)`, so a group deleted in the window between reading which ids are still valid and
 * the insert actually running would fail the whole multi-row insert on an FK violation -- and because
 * the delete had already committed on its own, the user was left in *no* groups at all: no admin
 * access, no page rules, with the caller's error saying nothing about membership having been wiped.
 * `setUserGroups` now wraps both statements in one transaction, so a failed insert rolls the delete
 * back with it. The two tests below prove this two different ways: sabotaging `WIKI.db.transaction`
 * itself to delete a group mid-transaction (reproducing the real FK-violation race), and handing the
 * transaction callback a `tx` stand-in whose `insert` is forced to throw outright.
 */
describe('users.setUserGroups (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users
  let groupAId: string
  let groupBId: string

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    // -> `setUserGroups` -> `groups.guestMembershipViolation` reads `WIKI.data.systemIds.guestsGroupId`
    //    -- a full-boot value the minimal test `WIKI` does not carry. Neither group id used below is
    //    this one, so it never actually matches; it only has to be present for the read not to throw.
    WIKI.data.systemIds = { guestsGroupId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } as any

    // -> No guests group in this fixture's seed data; `setUserGroups` reads this to keep the guest
    //    account/guests group pairing intact, and a value that matches neither group under test is
    //    what makes both of them ordinary, assignable groups.
    const [groupA] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'setUserGroups Group A', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    groupAId = groupA!.id

    const [groupB] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'setUserGroups Group B', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    groupBId = groupB!.id
  })

  test('an FK violation on the insert half rolls back the delete, leaving prior membership intact', async () => {
    const [raceUser] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'group-race@example.com',
        name: 'Group Race User',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    const [raceGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'FK Race Group', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })

    // -> Real prior membership -- this is what a botched transaction would leave the user stripped of
    await usersModel.setUserGroups(raceUser!.id, [fixtures.groupId])

    /*
      Sabotages the transaction from the outside, at exactly the point `setUserGroups` opens it --
      deleting the target group out from under the still-to-run insert reproduces the real race: a
      group deleted in the window between `setUserGroups` reading it as valid and the insert actually
      running. `WIKI.db.transaction` itself, and everything `setUserGroups` does inside it, run for
      real and unmocked; only the timing of the group's deletion is engineered.
    */
    const originalTransaction = WIKI.db.transaction.bind(WIKI.db)
    const transactionSpy = mock.method(WIKI.db, 'transaction', (fn: any) =>
      originalTransaction(async (tx: any) => {
        await fixtures.db.delete(groupsTable).where(eq(groupsTable.id, raceGroup!.id))
        return fn(tx)
      })
    )
    try {
      await assert.rejects(() => usersModel.setUserGroups(raceUser!.id, [raceGroup!.id]))
    } finally {
      transactionSpy.mock.restore()
    }

    const membership = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, raceUser!.id))
    assert.deepEqual(
      membership.map((m) => m.groupId),
      [fixtures.groupId],
      'the prior membership survived the failed insert instead of being left empty'
    )
  })

  test('leaves prior membership intact when the insert half of the swap fails', async (t) => {
    await usersModel.setUserGroups(fixtures.userId, [groupAId])
    const before = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, fixtures.userId))
    assert.deepEqual(
      before.map((r) => r.groupId),
      [groupAId]
    )

    const originalTransaction = fixtures.db.transaction.bind(fixtures.db)
    t.mock.method(fixtures.db, 'transaction', (callback: (tx: unknown) => Promise<unknown>) =>
      originalTransaction((tx: any) => {
        const fakeTx = {
          delete: tx.delete.bind(tx),
          insert: () => {
            throw new Error('simulated insert failure')
          }
        }
        return callback(fakeTx)
      })
    )

    await assert.rejects(
      usersModel.setUserGroups(fixtures.userId, [groupBId]),
      /simulated insert failure/
    )

    const after = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, fixtures.userId))
    assert.deepEqual(
      after.map((r) => r.groupId),
      [groupAId]
    )
  })
})

/**
 * `deleteUser` is SQL orchestration over four tables in one transaction — the same
 * real-database case `reassignContent (DB-backed)` above is for, not one a query-builder mock
 * would usefully stand in for: what's under test is that the avatar and open submissions are
 * really gone afterwards, and that a refused delete really leaves sessions/keys/avatar alone.
 */
describe('users.deleteUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  async function insertUser(email: string) {
    const [row] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return row!.id
  }

  function rawPageRow(overrides: { path: string; authorId: string }) {
    return {
      locale: 'en',
      path: overrides.path,
      hash: `delete-user-hash-${overrides.path}`,
      title: 'Delete Me',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: overrides.authorId,
      creatorId: overrides.authorId,
      ownerId: overrides.authorId,
      siteId: fixtures.siteId,
      classification: fixtures.classificationId
    }
  }

  test('deleting a user with an avatar leaves no userAvatars row and getAvatar() returns nothing', async () => {
    const userId = await insertUser('avatar-owner@example.com')
    await fixtures.db
      .insert(userAvatars)
      .values({ id: userId, data: Buffer.from('fake-jpeg'), hash: 'fake-hash' })

    const deleted = await usersModel.deleteUser(userId)

    assert.equal(deleted, true)
    const [avatarRow] = await fixtures.db
      .select()
      .from(userAvatars)
      .where(eq(userAvatars.id, userId))
    assert.equal(avatarRow, undefined)
    assert.equal(await usersModel.getAvatar(userId), null)
  })

  test("a delete refused by a foreign-key conflict leaves the user's sessions and keys intact", async () => {
    const userId = await insertUser('blocked-delete@example.com')
    await fixtures.db.insert(sessionsTable).values({ id: `sess-${userId}`, userId })
    await fixtures.db.insert(userKeys).values({
      kind: 'validation',
      token: `token-${userId}`,
      validUntil: new Date(Date.now() + 60_000),
      userId
    })
    // -> No onDelete cascade or set null on pages.authorId (see reassignContent's own doc comment),
    //    so an authored page is exactly what makes deleteUser() throw a 23503 foreign-key violation.
    await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'blocked/page', authorId: userId }))

    await assert.rejects(usersModel.deleteUser(userId))

    const [userRow] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
    assert.ok(userRow, 'the user row must still exist')
    const sessionRows = await fixtures.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, userId))
    assert.equal(sessionRows.length, 1)
    const keyRows = await fixtures.db.select().from(userKeys).where(eq(userKeys.userId, userId))
    assert.equal(keyRows.length, 1)
  })

  test('a user with an open edit submission is deletable because the transaction discards it', async () => {
    const userId = await insertUser('submitter@example.com')
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'submission/target', authorId: fixtures.userId }))
      .returning({ id: pagesTable.id })
    await fixtures.db.insert(pageEditSubmissionsTable).values({
      content: 'edited content',
      patch: '--- a\n+++ b\n',
      baseHash: 'deadbeef',
      pageId: page!.id,
      siteId: fixtures.siteId,
      authorId: userId
    })

    const deleted = await usersModel.deleteUser(userId)

    assert.equal(deleted, true)
    const submissionRows = await fixtures.db
      .select()
      .from(pageEditSubmissionsTable)
      .where(eq(pageEditSubmissionsTable.authorId, userId))
    assert.equal(submissionRows.length, 0)
  })
})

describe('users.importLocalUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    WIKI.data.systemIds = { localAuthId: 'import-local-auth-strategy-id' } as any
  })

  test('persists a passed isActive: false and the source createdAt, rather than the old hardcoded defaults', async () => {
    const sourceCreatedAt = new Date('2018-05-01T00:00:00.000Z')

    const result = await usersModel.importLocalUser({
      name: 'Deactivated Import',
      email: 'deactivated-import@example.com',
      passwordHash: '$2a$12$fakehashfordbbackedtest',
      isActive: false,
      isVerified: false,
      meta: { jobTitle: 'Staff Engineer', location: 'Remote' },
      prefs: { timezone: 'Europe/Berlin' },
      createdAt: sourceCreatedAt
    })

    assert.equal(result.status, 'created')
    if (result.status !== 'created') return

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, result.id))
    assert.equal(row!.isActive, false)
    assert.equal(row!.isVerified, false)
    assert.deepEqual(row!.meta, { jobTitle: 'Staff Engineer', location: 'Remote', pronouns: '' })
    assert.equal((row!.prefs as any).timezone, 'Europe/Berlin')
    assert.equal(row!.createdAt.toISOString(), sourceCreatedAt.toISOString())
  })

  test('falls back to isActive: false and the column defaults when no source state is given', async () => {
    const result = await usersModel.importLocalUser({
      name: 'Bare Import',
      email: 'bare-import@example.com',
      passwordHash: '$2a$12$fakehashfordbbackedtest'
    })

    assert.equal(result.status, 'created')
    if (result.status !== 'created') return

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, result.id))
    assert.equal(row!.isActive, false)
    assert.ok(row!.createdAt) // -> column's own defaultNow(), not left null
  })
})

/**
 * `applyUserUpdate()` atomicity (OpenProject #1609 / #1584): the profile patch, group replacement,
 * auth-flag write and session clear now share one `WIKI.db.transaction()` -- this is what
 * `PUT /users/:userId` calls in place of its previously separate, non-transactional sequence. A
 * failure partway through must leave every earlier write in the same call rolled back too.
 */
describe('users.applyUserUpdate atomicity (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let targetUserId: string
  const localStrategyId = 'atomic-update-test-strategy'

  before(async () => {
    WIKI.data.systemIds = { localAuthId: localStrategyId } as any

    targetUserId = await users.createUser({
      name: 'Apply Update Target',
      email: 'apply-update-target@example.com',
      password: 'original-password1',
      groups: [fixtures.groupId],
      isVerified: true
    })
  })

  test('a failure at the auth-flags step leaves the profile patch and group membership unchanged', async (t) => {
    t.mock.method(userCredentials, 'setUserAuthFlags', async () => {
      throw new Error('simulated auth-flag failure')
    })

    await assert.rejects(
      users.applyUserUpdate(targetUserId, {
        patch: { name: 'Renamed Mid-Transaction' },
        groups: [],
        authFlags: { mustChangePwd: true }
      }),
      /simulated auth-flag failure/
    )

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, targetUserId))
    assert.equal(row!.name, 'Apply Update Target')

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, targetUserId))
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0]!.groupId, fixtures.groupId)
  })

  test('the ordinary update path applies the profile patch, group change, and auth flags together', async () => {
    await users.applyUserUpdate(targetUserId, {
      patch: { name: 'Renamed For Real' },
      groups: [],
      authFlags: { mustChangePwd: true }
    })

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, targetUserId))
    assert.equal(row!.name, 'Renamed For Real')
    assert.equal((row!.auth as Record<string, any>)[localStrategyId].mustChangePwd, true)

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, targetUserId))
    assert.equal(memberships.length, 0)
  })
})
