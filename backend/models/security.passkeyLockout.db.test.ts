import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { users as usersTable } from '../db/schema.ts'
import { DISCONNECTED_AUTH_KEY } from '../helpers/userAuthEntries.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

const passkeys = { authenticators: [{ id: 'cred-1', name: 'Laptop' }] }

describe('Security#checkPasskeyLockout (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let security: typeof import('./security.ts').security
  let seq = 0

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    fixtures = await setupTestDb()
    ;({ security } = await import('./security.ts'))
  })

  after(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await teardownTestDb()
  })

  beforeEach(async () => {
    await fixtures.db.delete(usersTable)
    CARDINAL.config.security = { allowPasskeys: true }
    // -> Both enabled and loaded, unless a test says otherwise: only a working one is a way in
    CARDINAL.auth.strategies = { local: {}, github: {} } as any
  })

  async function addUser(auth: Record<string, unknown>, passkeyStore: object = passkeys) {
    seq += 1
    await fixtures.db.insert(usersTable).values({
      email: `lockout-${seq}@example.com`,
      name: `Lockout ${seq}`,
      isActive: true,
      isVerified: true,
      auth,
      passkeys: passkeyStore
    })
  }

  test('refuses, naming the count, when password login is restricted and a passkey is the only way in', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } })
    await addUser({ local: { password: 'x', restrictLogin: true } })

    const error = await security.checkPasskeyLockout({ allowPasskeys: false })
    assert.match(error ?? '', /2 accounts/)
  })

  test('uses the singular for exactly one account', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } })

    const error = await security.checkPasskeyLockout({ allowPasskeys: false })
    assert.match(error ?? '', /1 account has/)
  })

  test('allows the switch when no account is affected', async () => {
    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: false }), null)
  })

  test('allows it when the local login is not restricted', async () => {
    await addUser({ local: { password: 'x', isPasswordKnown: true, restrictLogin: false } })
    await addUser({ local: { password: 'x', isPasswordKnown: true } })

    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: false }), null)
  })

  test('allows it when another provider still works alongside the restricted local login', async () => {
    await addUser({
      local: { password: 'x', restrictLogin: true },
      github: { id: '1' }
    })

    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: false }), null)
  })

  test('refuses when the only other provider belongs to a disabled or deleted strategy', async () => {
    CARDINAL.auth.strategies = { local: {} } as any
    await addUser({
      local: { password: 'x', restrictLogin: true },
      github: { id: '1' }
    })

    assert.match((await security.checkPasskeyLockout({ allowPasskeys: false })) ?? '', /1 account/)
  })

  test('refuses when the password is one its holder does not know', async () => {
    await addUser({ local: { password: 'x', isPasswordKnown: false } })

    assert.match((await security.checkPasskeyLockout({ allowPasskeys: false })) ?? '', /1 account/)
  })

  test('a record of a disconnected provider is not mistaken for a way in', async () => {
    await addUser({
      local: { password: 'x', restrictLogin: true },
      [DISCONNECTED_AUTH_KEY]: { github: '2026-09-23T00:00:00.000Z' }
    })

    assert.match((await security.checkPasskeyLockout({ allowPasskeys: false })) ?? '', /1 account/)
  })

  test('ignores a restricted account that has no passkey', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } }, {})

    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: false }), null)
  })

  test('does not fire when allowPasskeys is unchanged or true', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } })

    assert.equal(await security.checkPasskeyLockout({}), null)
    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: true }), null)
  })

  test('does not refuse re-saving a value that is already off', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } })
    CARDINAL.config.security = { allowPasskeys: false }

    assert.equal(await security.checkPasskeyLockout({ allowPasskeys: false }), null)
  })

  test('treats an unset stored value as on', async () => {
    await addUser({ local: { password: 'x', restrictLogin: true } })
    CARDINAL.config.security = {}

    assert.match((await security.checkPasskeyLockout({ allowPasskeys: false })) ?? '', /1 account/)
  })
})
