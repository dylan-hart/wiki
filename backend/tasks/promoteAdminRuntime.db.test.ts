import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { groups as groupsTable, users as usersTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'
import { promoteUserToAdmin } from './promoteAdminRuntime.ts'
import type { WikiDb } from '../core/db.ts'

/**
 * DB-backed: `promoteUserToAdmin()` is exercised against a real Postgres instance, not
 * `bootstrapPromoteAdminRuntime()` -- that half only wires up config/db/models the same way
 * `worker.ts`/`migration/bootstrap.ts` already do and has no logic of its own worth a DB round trip
 * for. `setupTestDb()` seeds one group (`groupId`) which stands in for the instance's Administrators
 * group here -- what matters to the code under test is that `WIKI.config.auth.rootAdminGroupId` names
 * a real `groups` row, not that it is named "Administrators".
 */
describe('promoteUserToAdmin()', { skip: !hasTestDatabase() }, () => {
  let db: WikiDb
  let rootAdminGroupId: string
  let otherGroupId: string

  before(async () => {
    const fixtures = await setupTestDb()
    db = fixtures.db
    rootAdminGroupId = fixtures.groupId
    WIKI.config.auth = { rootAdminGroupId }

    const [other] = await db
      .insert(groupsTable)
      .values({ name: 'Other Group', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    otherGroupId = other!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  async function seedUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: overrides.email ?? `user-${Date.now()}-${Math.random()}@example.com`,
        name: overrides.name ?? 'Test User',
        isActive: true,
        isVerified: true,
        ...overrides
      })
      .returning({ id: usersTable.id })
    return user!.id
  }

  test('promotes an existing user into the admin group', async () => {
    const email = 'promote-me@example.com'
    const userId = await seedUser({ email })

    const result = await promoteUserToAdmin(WIKI, email)

    assert.deepEqual(result, { status: 'promoted', userId })
    assert.equal(await WIKI.models.groups.isUserInGroup(rootAdminGroupId, userId), true)
  })

  test('is a no-op when the user is already an admin', async () => {
    const email = 'already-admin@example.com'
    const userId = await seedUser({ email })
    await WIKI.models.groups.assignUserToGroup(rootAdminGroupId, userId)

    const result = await promoteUserToAdmin(WIKI, email)

    assert.deepEqual(result, { status: 'already-admin', userId })
  })

  test('preserves the user’s existing non-admin group memberships', async () => {
    const email = 'has-other-group@example.com'
    const userId = await seedUser({ email })
    await WIKI.models.groups.assignUserToGroup(otherGroupId, userId)

    await promoteUserToAdmin(WIKI, email)

    assert.equal(await WIKI.models.groups.isUserInGroup(otherGroupId, userId), true)
    assert.equal(await WIKI.models.groups.isUserInGroup(rootAdminGroupId, userId), true)
  })

  test('throws for an unknown email', async () => {
    await assert.rejects(
      () => promoteUserToAdmin(WIKI, 'nobody-here@example.com'),
      /No user found with email/
    )
  })

  test('refuses to promote the guest/system account', async () => {
    const [guest] = await db
      .insert(usersTable)
      .values({
        email: 'guest-account@example.com',
        name: 'Guest',
        isSystem: true,
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })

    await assert.rejects(
      () => promoteUserToAdmin(WIKI, 'guest-account@example.com'),
      /cannot be a member of any group/
    )
    assert.equal(await WIKI.models.groups.isUserInGroup(rootAdminGroupId, guest!.id), false)
  })

  test('throws when the Administrators group id cannot be resolved', async () => {
    const email = 'no-admin-group-configured@example.com'
    await seedUser({ email })
    const savedAuth = WIKI.config.auth
    WIKI.config.auth = {}

    try {
      await assert.rejects(
        () => promoteUserToAdmin(WIKI, email),
        /Could not resolve the Administrators group id/
      )
    } finally {
      WIKI.config.auth = savedAuth
    }
  })
})
