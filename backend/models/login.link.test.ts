import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { login } from './login.ts'
import { installTestWiki } from '../test/mocks.ts'

function makeStrategy(overrides: Partial<any> = {}): any {
  return {
    id: 'strategy-gh',
    module: 'github',
    displayName: 'Company GitHub',
    isEnabled: true,
    autoProvision: false,
    allowedEmailRegex: '',
    autoEnrollGroups: [],
    trustEmailForLinking: false,
    config: {},
    ...overrides
  }
}

describe('login.linkProviderToAccount', () => {
  let linkStrategy: ReturnType<typeof mock.fn>
  let wiki: { restore(): void }

  beforeEach(() => {
    linkStrategy = mock.fn(async () => {})
    wiki = installTestWiki({
      data: { authentication: [{ key: 'github', title: 'GitHub' }] },
      models: {
        flags: { authDebug: () => {} },
        userCredentials: { linkStrategy }
      }
    })
  })

  afterEach(() => wiki.restore())

  test('hands the provider identity to linkStrategy with a normalized address', async () => {
    await login.linkProviderToAccount({
      userId: 'user-1',
      strategy: makeStrategy(),
      profile: { id: 'gh-42', email: '  Other@Example.ORG ', name: 'Ada', idToken: 'SECRET' },
      siteId: 'site-1',
      ip: '203.0.113.9'
    })

    assert.equal(linkStrategy.mock.calls.length, 1)
    assert.deepEqual(linkStrategy.mock.calls[0]!.arguments[0], {
      userId: 'user-1',
      strategyId: 'strategy-gh',
      identity: { id: 'gh-42', email: 'other@example.org' },
      methodName: 'Company GitHub',
      siteId: 'site-1',
      ip: '203.0.113.9'
    })
  })

  test("names the method after the module's title when the strategy has no display name", async () => {
    await login.linkProviderToAccount({
      userId: 'user-1',
      strategy: makeStrategy({ displayName: '' }),
      profile: { id: 'gh-42', email: 'a@example.org', name: 'Ada' }
    })

    assert.equal((linkStrategy.mock.calls[0]!.arguments[0] as any).methodName, 'GitHub')
  })

  test("refuses an address outside the strategy's allowedEmailRegex before writing anything", async () => {
    await assert.rejects(
      login.linkProviderToAccount({
        userId: 'user-1',
        strategy: makeStrategy({ allowedEmailRegex: '^[^@]+@corp\\.example$' }),
        profile: { id: 'gh-42', email: 'someone@elsewhere.example', name: 'Ada' }
      }),
      /ERR_EMAIL_NOT_ALLOWED/
    )
    assert.equal(linkStrategy.mock.calls.length, 0)
  })

  test('accepts an address different from the account address when the pattern allows it', async () => {
    await login.linkProviderToAccount({
      userId: 'user-1',
      strategy: makeStrategy({ allowedEmailRegex: '^[^@]+@corp\\.example$' }),
      profile: { id: 'gh-42', email: 'ada@corp.example', name: 'Ada' }
    })

    assert.equal(linkStrategy.mock.calls.length, 1)
  })

  test('passes linkStrategy refusals through unchanged', async () => {
    linkStrategy = mock.fn(async () => {
      throw new Error('ERR_LINK_IDENTITY_IN_USE')
    })
    ;(CARDINAL.models as any).userCredentials = { linkStrategy }

    await assert.rejects(
      login.linkProviderToAccount({
        userId: 'user-1',
        strategy: makeStrategy(),
        profile: { id: 'gh-42', email: 'a@example.org', name: 'Ada' }
      }),
      /ERR_LINK_IDENTITY_IN_USE/
    )
  })
})

/**
 * Driven directly, as in `login.providers.test.ts`, with the user lookups stubbed: the account a
 * returning provider login resolves to is what is under test.
 */
describe('login.findOrCreateProviderUser resolves a connected identity by its stored link', () => {
  const linkedUser = {
    id: 'user-linked',
    email: 'ada@example.com',
    name: 'Ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    isSystem: false,
    auth: { 'strategy-gh': { id: 'gh-42', email: 'ada-work@corp.example' } }
  }
  const otherUser = {
    id: 'user-other',
    email: 'ada-work@corp.example',
    name: 'Someone Else',
    firstName: 'Someone',
    lastName: 'Else',
    isSystem: false,
    auth: {}
  }

  let byProviderLink: any
  let getByEmail: ReturnType<typeof mock.fn>
  let createUser: ReturnType<typeof mock.fn>
  let patchStrategyAuth: ReturnType<typeof mock.fn>
  let wiki: { restore(): void }

  beforeEach(() => {
    byProviderLink = linkedUser
    getByEmail = mock.fn(async (email: string) => (email === otherUser.email ? otherUser : null))
    createUser = mock.fn(async () => 'user-new')
    patchStrategyAuth = mock.fn(async () => true)
    wiki = installTestWiki({
      data: { systemIds: { localAuthId: 'local-id' } },
      models: {
        flags: { authDebug: () => {} },
        users: {
          getByProviderLink: async (strategyId: string, providerId: string) =>
            strategyId === 'strategy-gh' && providerId === 'gh-42' ? byProviderLink : null,
          getByEmail,
          createUser,
          getById: async () => null
        },
        userCredentials: { patchStrategyAuth }
      }
    })
  })

  afterEach(() => wiki.restore())

  function findOrCreate(strategy: any, profile: any): Promise<any> {
    return (login as any).findOrCreateProviderUser(strategy, profile)
  }

  test('a provider connected under a different address signs in to the account it is linked to', async () => {
    const user = await findOrCreate(makeStrategy({ autoProvision: true }), {
      id: 'gh-42',
      email: 'ada-work@corp.example',
      name: 'Ada'
    })

    assert.equal(user.id, 'user-linked')
    assert.equal(getByEmail.mock.calls.length, 0)
    assert.equal(createUser.mock.calls.length, 0)
    assert.deepEqual(patchStrategyAuth.mock.calls[0]!.arguments.slice(0, 2), [
      'user-linked',
      'strategy-gh'
    ])
  })

  test('with no stored link, falls back to the address lookup unchanged', async () => {
    byProviderLink = null

    await assert.rejects(
      findOrCreate(makeStrategy(), { id: 'gh-42', email: 'ada-work@corp.example', name: 'Ada' }),
      /ERR_ACCOUNT_NOT_LINKED/
    )
    assert.equal(getByEmail.mock.calls.length, 1)
  })

  test("the linked account still has to satisfy the strategy's allowedEmailRegex", async () => {
    await assert.rejects(
      findOrCreate(makeStrategy({ allowedEmailRegex: '^[^@]+@allowed\\.example$' }), {
        id: 'gh-42',
        email: 'ada-work@corp.example',
        name: 'Ada'
      }),
      /ERR_EMAIL_NOT_ALLOWED/
    )
  })

  test('a stored link never reaches a system account', async () => {
    byProviderLink = { ...linkedUser, isSystem: true }

    await assert.rejects(
      findOrCreate(makeStrategy(), { id: 'gh-42', email: 'ada-work@corp.example', name: 'Ada' }),
      /ERR_LOGIN_FAILED/
    )
  })
})
