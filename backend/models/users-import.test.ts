import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { users } from './users.ts'

/**
 * Coverage for `Users.importLocalUser()` (Feature 414, Task 728): the import-capable local-provider
 * creation path that carries a pre-hashed password over verbatim instead of re-hashing it.
 *
 * `Users` reads the ambient `WIKI` global for everything DB/config-related, so each test installs a
 * minimal fake on `globalThis.WIKI` and restores whatever was there before. `getByEmail()` and
 * `setUserGroups()` are real methods on the same singleton `users` instance that `importLocalUser()`
 * calls internally (`this.getByEmail(...)`, `this.setUserGroups(...)`); rather than re-implementing
 * their own DB access in a fake `WIKI.db`, tests stub those two methods directly on the instance —
 * they're already-existing, separately-owned behaviour, not what this task adds.
 */

const LOCAL_STRATEGY_ID = 'local-auth-strategy-uuid'

function installFakeWiki(overrides: { insertResult?: { id: string }; insertError?: any } = {}) {
  const previous = (globalThis as any).WIKI
  const insertedRows: any[] = []
  ;(globalThis as any).WIKI = {
    data: { systemIds: { localAuthId: LOCAL_STRATEGY_ID } },
    config: { userDefaults: {} },
    logger: { warn: () => {} },
    models: {
      flags: { authDebug: () => {} },
      hooks: { emit: async () => {} }
    },
    db: {
      insert() {
        return {
          values(row: any) {
            insertedRows.push(row)
            return {
              async returning() {
                if (overrides.insertError) {
                  throw overrides.insertError
                }
                return [overrides.insertResult ?? { id: 'new-user-uuid' }]
              }
            }
          }
        }
      }
    }
  }
  return {
    insertedRows,
    restore: () => {
      ;(globalThis as any).WIKI = previous
    }
  }
}

/** Stubs `users.getByEmail`/`users.setUserGroups` on the singleton for the duration of one test,
 * restoring the originals afterwards regardless of outcome. */
function stubInstanceMethods(overrides: {
  getByEmail?: (...args: any[]) => any
  setUserGroups?: (...args: any[]) => any
}) {
  const originalGetByEmail = users.getByEmail
  const originalSetUserGroups = users.setUserGroups
  if (overrides.getByEmail) {
    users.getByEmail = overrides.getByEmail as any
  }
  if (overrides.setUserGroups) {
    users.setUserGroups = overrides.setUserGroups as any
  }
  return () => {
    users.getByEmail = originalGetByEmail
    users.setUserGroups = originalSetUserGroups
  }
}

let restoreWiki: (() => void) | undefined
let restoreInstance: (() => void) | undefined

afterEach(() => {
  restoreWiki?.()
  restoreInstance?.()
  restoreWiki = undefined
  restoreInstance = undefined
})

describe('Users.importLocalUser', () => {
  test('writes the source hash verbatim under auth[localStrategyId].password, never re-hashing it', async () => {
    const fakeWiki = installFakeWiki()
    restoreWiki = fakeWiki.restore
    restoreInstance = stubInstanceMethods({ getByEmail: async () => null })

    const sourceHash = '$2a$12$abcdefghijklmnopqrstuv.somebcryptjshashvalue1234567890'
    const result = await users.importLocalUser({
      name: 'Imported User',
      email: 'imported@example.com',
      passwordHash: sourceHash,
      mustChangePassword: true
    })

    assert.equal(result.status, 'created')
    assert.equal(fakeWiki.insertedRows.length, 1)
    const authEntry = fakeWiki.insertedRows[0].auth[LOCAL_STRATEGY_ID]
    // -> Exactly the source string, not run through bcrypt.hash() (a re-hash would neither equal the
    //    source string nor be a fixed-length transformation of it we could predict here).
    assert.equal(authEntry.password, sourceHash)
    assert.equal(authEntry.mustChangePwd, true)
    assert.equal(authEntry.restrictLogin, false)
  })

  test('always resets tfaIsActive/tfaSecret rather than carrying them over (explicit decision, not just a default)', async () => {
    const fakeWiki = installFakeWiki()
    restoreWiki = fakeWiki.restore
    restoreInstance = stubInstanceMethods({ getByEmail: async () => null })

    await users.importLocalUser({
      name: 'Imported User',
      email: 'imported@example.com',
      passwordHash: '$2a$12$fakehash'
    })

    const authEntry = fakeWiki.insertedRows[0].auth[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.tfaIsActive, false)
    assert.equal(authEntry.tfaSecret, '')
    assert.equal(authEntry.tfaRequired, false)
  })

  test('lowercases the email exactly as createUser does', async () => {
    const fakeWiki = installFakeWiki()
    restoreWiki = fakeWiki.restore
    restoreInstance = stubInstanceMethods({ getByEmail: async () => null })

    await users.importLocalUser({
      name: 'Imported User',
      email: 'Mixed.Case@Example.COM',
      passwordHash: '$2a$12$fakehash'
    })

    assert.equal(fakeWiki.insertedRows[0].email, 'mixed.case@example.com')
  })

  test('skip-and-flag: an existing email is not overwritten, insert is never attempted, and the result says why', async () => {
    const fakeWiki = installFakeWiki()
    restoreWiki = fakeWiki.restore
    restoreInstance = stubInstanceMethods({
      getByEmail: async () => ({ id: 'existing-user-uuid', email: 'taken@example.com' })
    })

    const result = await users.importLocalUser({
      name: 'Imported User',
      email: 'taken@example.com',
      passwordHash: '$2a$12$fakehash'
    })

    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'email-collision',
      existingId: 'existing-user-uuid'
    })
    assert.equal(fakeWiki.insertedRows.length, 0)
  })

  test('downgrades a race unique-violation on insert to skipped/email-collision rather than throwing', async () => {
    const raceError: any = new Error(
      'duplicate key value violates unique constraint "users_email_unique"'
    )
    raceError.code = '23505'
    const fakeWiki = installFakeWiki({ insertError: raceError })
    restoreWiki = fakeWiki.restore
    // getByEmail found nothing at check time, but another writer wins the race before this insert lands.
    restoreInstance = stubInstanceMethods({ getByEmail: async () => null })

    const result = await users.importLocalUser({
      name: 'Imported User',
      email: 'race@example.com',
      passwordHash: '$2a$12$fakehash'
    })

    assert.equal(result.status, 'skipped')
    assert.equal((result as any).reason, 'email-collision')
  })

  test('a non-collision insert failure still propagates rather than being swallowed', async () => {
    const otherError: any = new Error('connection terminated unexpectedly')
    otherError.code = '57P01'
    const fakeWiki = installFakeWiki({ insertError: otherError })
    restoreWiki = fakeWiki.restore
    restoreInstance = stubInstanceMethods({ getByEmail: async () => null })

    await assert.rejects(
      () =>
        users.importLocalUser({
          name: 'Imported User',
          email: 'other-error@example.com',
          passwordHash: '$2a$12$fakehash'
        }),
      /connection terminated/
    )
  })

  test('assigns target group ids via the map from the previous task by delegating to setUserGroups', async () => {
    const fakeWiki = installFakeWiki({ insertResult: { id: 'grouped-user-uuid' } })
    restoreWiki = fakeWiki.restore
    const setUserGroupsCalls: Array<[string, string[]]> = []
    restoreInstance = stubInstanceMethods({
      getByEmail: async () => null,
      setUserGroups: async (userId: string, groupIds: string[]) => {
        setUserGroupsCalls.push([userId, groupIds])
      }
    })

    const targetGroupIds = ['target-group-uuid-1', 'target-group-uuid-2']
    const result = await users.importLocalUser({
      name: 'Imported User',
      email: 'grouped@example.com',
      passwordHash: '$2a$12$fakehash',
      groups: targetGroupIds
    })

    assert.equal(result.status, 'created')
    assert.deepEqual(setUserGroupsCalls, [['grouped-user-uuid', targetGroupIds]])
  })

  test('does not call setUserGroups when no groups are given', async () => {
    const fakeWiki = installFakeWiki()
    restoreWiki = fakeWiki.restore
    let called = false
    restoreInstance = stubInstanceMethods({
      getByEmail: async () => null,
      setUserGroups: async () => {
        called = true
      }
    })

    await users.importLocalUser({
      name: 'Imported User',
      email: 'nogroups@example.com',
      passwordHash: '$2a$12$fakehash'
    })

    assert.equal(called, false)
  })
})
