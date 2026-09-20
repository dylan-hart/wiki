import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import LocalAuthentication from './authentication.ts'
import { installTestWiki } from '../../../test/mocks.ts'

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

  test('throws ERR_LOGIN_RESTRICTED when the strategy data marks the login restricted', async () => {
    stubGetByEmail(makeUser({ auth: { local: makeAuthStrategyData({ restrictLogin: true }) } }))
    const local = new LocalAuthentication('local', {})
    await assert.rejects(
      local.authenticate({ username: 'ada@example.com', password: 'correct-horse' }),
      /ERR_LOGIN_RESTRICTED/
    )
  })

  /*
    A local account is created by the model layer and the registration route, both of which take a
    first and last name outright, so this module hands over no display string and builds no
    `ProviderProfile` anything could be split from.
  */
  test('builds no provider profile — there is no display string here to split (OpenProject #2641)', () => {
    const local = new LocalAuthentication('local', {}) as unknown as Record<string, unknown>
    assert.equal(typeof local.profile, 'undefined')
    assert.equal(typeof local.authenticate, 'function')
  })
})
