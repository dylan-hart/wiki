import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import LocalAuthentication from './authentication.ts'
import { installTestWiki } from '../../../test/mocks.ts'

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
  wikiHandle = installTestWiki({
    models: {
      users: {
        getByEmail: async (email: string) => {
          assert.equal(email, email.toLowerCase(), 'authenticate must lowercase before lookup')
          return user
        }
      }
    }
  })
}

let wikiHandle: { restore(): void }

afterEach(() => {
  wikiHandle.restore()
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

  test('an unknown address and a known address with no strategy entry produce the identical response', async () => {
    stubGetByEmail(null)
    const unknownAddress = new LocalAuthentication('local', {})
    const unknownError = await unknownAddress
      .authenticate({ username: 'nobody@example.com', password: 'anything' })
      .catch((err: any) => err)

    stubGetByEmail(makeUser({ auth: { google: {} } }))
    const noStrategyEntry = new LocalAuthentication('local', {})
    const noStrategyError = await noStrategyEntry
      .authenticate({ username: 'ada@example.com', password: 'anything' })
      .catch((err: any) => err)

    assert.ok(unknownError instanceof Error)
    assert.ok(noStrategyError instanceof Error)
    assert.equal(unknownError.message, 'ERR_LOGIN_FAILED')
    assert.equal(noStrategyError.message, unknownError.message)
  })

  test('throws ERR_LOGIN_FAILED on an incorrect password', async () => {
    stubGetByEmail(makeUser())
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'wrong-password' }),
      /ERR_LOGIN_FAILED/
    )
  })

  // -> `isActive`/`isVerified` are no longer checked here (OpenProject #2094): they moved to
  //    `models/users.ts#afterLoginChecks()`, the funnel every login path -- including this one --
  //    ends in, so a coverage for those two now belongs to that method's own test suite
  //    (`models/users.test.ts`) rather than this module's. `restrictLogin` has no other enforcement
  //    point and stays checked here.
  test('throws ERR_LOGIN_RESTRICTED when the strategy data marks the login restricted', async () => {
    stubGetByEmail(makeUser({ auth: { local: makeAuthStrategyData({ restrictLogin: true }) } }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_LOGIN_RESTRICTED/
    )
  })
})
