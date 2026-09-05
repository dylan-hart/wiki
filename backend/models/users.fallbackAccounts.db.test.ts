import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { users as usersTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `getFallbackAccounts()` is SQL orchestration over a dynamically-keyed JSONB path (the `auth`
 * column, keyed by strategy id) — exactly the `models/pages.test.ts`-style case CLAUDE.md calls out
 * for a real database rather than a query builder mock, since a mock of the JSONB `->`/`->>`
 * operators would mostly just be re-describing the SQL under test rather than verifying it.
 */
describe('users.getFallbackAccounts (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  const localStrategyId = '10000000-0000-4000-8000-000000000099'

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    fixtures = await setupTestDb()
    // -> `setupTestDb()`'s WIKI stub defaults `data.systemIds` to `{}` (see `test/mocks.ts`) —
    //    `getFallbackAccounts()` reads `WIKI.data.systemIds.localAuthId` directly, the same way
    //    `models/login.ts#clearMigratedFallbackLocalAuth` does, so this suite supplies one.
    WIKI.data.systemIds.localAuthId = localStrategyId
  })

  after(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await teardownTestDb()
  })

  test('lists only accounts with BOTH mustChangePwd and migratedFallbackProvider set, oldest first', async () => {
    const { users: usersModel } = await import('./users.ts')

    const [pendingOlder] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'pending-older@example.com',
        name: 'Pending Older',
        isActive: true,
        isVerified: true,
        // -> Explicit, distinct `createdAt` values (rather than relying on the column's own
        //    `defaultNow()` across two sequential inserts) so the ordering assertion below cannot
        //    flake on two rows landing in the same microsecond.
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        auth: {
          [localStrategyId]: {
            password: 'x',
            mustChangePwd: true,
            migratedFallbackProvider: 'ldap'
          }
        }
      })
      .returning({ id: usersTable.id })

    const [pendingNewer] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'pending-newer@example.com',
        name: 'Pending Newer',
        isActive: true,
        isVerified: true,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        auth: {
          [localStrategyId]: {
            password: 'x',
            mustChangePwd: true,
            migratedFallbackProvider: 'google'
          }
        }
      })
      .returning({ id: usersTable.id })

    // -> Already relinked via SSO: `clearMigratedFallbackLocalAuth` clears both fields together, so
    //    this account must NOT appear even though it once was a fallback account.
    await fixtures.db.insert(usersTable).values({
      email: 'relinked@example.com',
      name: 'Relinked',
      isActive: true,
      isVerified: true,
      auth: {
        [localStrategyId]: {
          password: 'x',
          mustChangePwd: false
        }
      }
    })

    // -> A genuine local account an administrator forced a password reset on: `mustChangePwd: true`
    //    with no marker at all. Must not be mistaken for a migrated fallback account.
    await fixtures.db.insert(usersTable).values({
      email: 'forced-reset@example.com',
      name: 'Forced Reset',
      isActive: true,
      isVerified: true,
      auth: {
        [localStrategyId]: {
          password: 'x',
          mustChangePwd: true
        }
      }
    })

    const results = await usersModel.getFallbackAccounts()

    assert.deepEqual(
      results.map((r) => r.email),
      ['pending-older@example.com', 'pending-newer@example.com']
    )
    assert.equal(results[0]!.id, pendingOlder!.id)
    assert.equal(results[0]!.providerKey, 'ldap')
    assert.equal(results[1]!.id, pendingNewer!.id)
    assert.equal(results[1]!.providerKey, 'google')
  })
})
