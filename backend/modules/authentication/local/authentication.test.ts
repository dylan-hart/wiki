import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import LocalAuthentication from './authentication.ts'

/**
 * `authenticate()` is the password-login path every e2e spec depends on (see CLAUDE.md's Testing
 * (e2e) section). It touches only `WIKI.models.users.getByEmail` — no database, so this is a pure
 * unit test with `getByEmail` stubbed to return a canned row per test.
 */

function makeAuthStrategyData(overrides: Partial<any> = {}) {
  return {
    password: bcrypt.hashSync('correct-horse', 1),
    restrictLogin: false,
    ...overrides
  }
}

function makeUser(overrides: Partial<any> = {}) {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    isActive: true,
    isVerified: true,
    auth: {
      local: makeAuthStrategyData()
    },
    ...overrides
  }
}

function stubGetByEmail(user: any) {
  ;(globalThis as any).WIKI = {
    models: {
      users: {
        getByEmail: async (email: string) => {
          assert.equal(email, email.toLowerCase(), 'authenticate must lowercase before lookup')
          return user
        }
      }
    }
  }
}

afterEach(() => {
  delete (globalThis as any).WIKI
})

describe('LocalAuthentication.authenticate', () => {
  test('returns the user row on a correct password', async () => {
    stubGetByEmail(makeUser())
    const local = new LocalAuthentication('local', {})
    const user = await local.authenticate({
      username: 'Ada@Example.com',
      password: 'correct-horse'
    })
    assert.equal(user.id, 'user-1')
  })

  test('throws ERR_LOGIN_FAILED when no user matches the email', async () => {
    stubGetByEmail(null)
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'nobody@example.com', password: 'anything' }),
      /ERR_LOGIN_FAILED/
    )
  })

  test('throws ERR_LOGIN_FAILED (not ERR_INVALID_STRATEGY) when the user has no local auth data (e.g. SSO-only account)', async () => {
    stubGetByEmail(makeUser({ auth: { google: {} } }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_LOGIN_FAILED/
    )
  })

  test('an unknown address and a known address with no local strategy data produce the identical response, both after a bcrypt comparison', async () => {
    const compareCalls: Array<{ password: string; hash: string }> = []
    const originalCompare = bcrypt.compare
    ;(bcrypt as any).compare = async (pwd: string, hash: string) => {
      compareCalls.push({ password: pwd, hash })
      return originalCompare(pwd, hash)
    }
    try {
      stubGetByEmail(null)
      const local = new LocalAuthentication('local', {})
      let unknownErrorMessage: string | undefined
      try {
        await local.authenticate({ username: 'nobody@example.com', password: 'anything' })
      } catch (err: any) {
        unknownErrorMessage = err.message
      }

      stubGetByEmail(makeUser({ auth: { google: {} } }))
      let noStrategyErrorMessage: string | undefined
      try {
        await local.authenticate({ username: 'ada@example.com', password: 'anything' })
      } catch (err: any) {
        noStrategyErrorMessage = err.message
      }

      assert.equal(unknownErrorMessage, 'ERR_LOGIN_FAILED')
      assert.equal(noStrategyErrorMessage, 'ERR_LOGIN_FAILED')
      assert.equal(unknownErrorMessage, noStrategyErrorMessage)
      assert.equal(compareCalls.length, 2, 'both branches must perform a bcrypt comparison')
    } finally {
      ;(bcrypt as any).compare = originalCompare
    }
  })

  test('throws ERR_LOGIN_FAILED on an incorrect password', async () => {
    stubGetByEmail(makeUser())
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'wrong-password' }),
      /ERR_LOGIN_FAILED/
    )
  })

  test('throws ERR_INACTIVE_USER for a correct password on a deactivated account', async () => {
    stubGetByEmail(makeUser({ isActive: false }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_INACTIVE_USER/
    )
  })

  test('throws ERR_LOGIN_RESTRICTED when the strategy data marks the login restricted', async () => {
    stubGetByEmail(makeUser({ auth: { local: makeAuthStrategyData({ restrictLogin: true }) } }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_LOGIN_RESTRICTED/
    )
  })

  test('throws ERR_USER_NOT_VERIFIED for an unverified account', async () => {
    stubGetByEmail(makeUser({ isVerified: false }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_USER_NOT_VERIFIED/
    )
  })

  test('checks isActive/restrictLogin/isVerified in that order (inactive wins over restricted/unverified)', async () => {
    stubGetByEmail(
      makeUser({
        isActive: false,
        isVerified: false,
        auth: { local: makeAuthStrategyData({ restrictLogin: true }) }
      })
    )
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_INACTIVE_USER/
    )
  })
})
