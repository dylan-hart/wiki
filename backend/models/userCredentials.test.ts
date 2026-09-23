import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { countAlternativeLogins, matchRecoveryCode } from './userCredentials.ts'
import type { RecoveryCodeEntry } from './userCredentials.ts'

/**
 * Entries are hashed with a low `bcrypt` cost purely for test speed — `matchRecoveryCode` itself takes
 * whatever cost is baked into each stored hash, same as production.
 */
describe('userCredentials.matchRecoveryCode', () => {
  async function makeEntries(
    codes: string[],
    usedIndexes: number[] = []
  ): Promise<RecoveryCodeEntry[]> {
    return Promise.all(
      codes.map(async (code, i) => ({
        hash: await bcrypt.hash(code, 4),
        usedAt: usedIndexes.includes(i) ? '2024-01-01T00:00:00.000Z' : null
      }))
    )
  }

  test('matches the entry whose hash corresponds to the code', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222', 'CCCC3333'])
    assert.equal(await matchRecoveryCode(entries, 'BBBB2222'), 1)
  })

  test('returns -1 when no unconsumed entry matches', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222'])
    assert.equal(await matchRecoveryCode(entries, 'ZZZZ9999'), -1)
  })

  test('skips an already-consumed entry even when the code matches it', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222'], [0])
    assert.equal(await matchRecoveryCode(entries, 'AAAA1111'), -1)
  })

  test('checks every unconsumed entry rather than stopping at the first non-match', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444'])
    assert.equal(await matchRecoveryCode(entries, 'DDDD4444'), 3)
  })

  test('an empty set never matches', async () => {
    assert.equal(await matchRecoveryCode([], 'AAAA1111'), -1)
  })
})

describe('userCredentials.countAlternativeLogins', () => {
  const STRATEGY = 'strategy-a'
  const user = {
    auth: { [STRATEGY]: {}, 'strategy-b': { restrictLogin: true } },
    passkeys: { authenticators: [{ id: 'k1' }] }
  }

  function withSecurity(security: Record<string, any> | undefined) {
    ;(globalThis as any).CARDINAL = { config: { security } }
  }

  afterEach(() => {
    delete (globalThis as any).CARDINAL
  })

  test('counts a registered passkey while passkeys are allowed', () => {
    withSecurity({ allowPasskeys: true })
    assert.equal(countAlternativeLogins(user, STRATEGY), 1)
  })

  test('an absent switch counts as allowed', () => {
    withSecurity(undefined)
    assert.equal(countAlternativeLogins(user, STRATEGY), 1)
  })

  test('ignores passkeys while the switch is off, so password login cannot rest on one', () => {
    withSecurity({ allowPasskeys: false })
    assert.equal(countAlternativeLogins(user, STRATEGY), 0)
  })

  test('still counts another unrestricted provider while the switch is off', () => {
    withSecurity({ allowPasskeys: false })
    const linked = { ...user, auth: { ...user.auth, 'strategy-c': {} } }
    assert.equal(countAlternativeLogins(linked, STRATEGY), 1)
  })

  describe('a stored password', () => {
    const LOCAL = 'strategy-local'

    function withLocal(entry: Record<string, any>) {
      return { auth: { [STRATEGY]: { id: 'p1' }, [LOCAL]: entry } }
    }

    test('counts when the account holder knows it', () => {
      withSecurity({ allowPasskeys: false })
      assert.equal(
        countAlternativeLogins(withLocal({ password: 'hash', isPasswordKnown: true }), STRATEGY),
        1
      )
    })

    test('does not count when it was generated for a provider-provisioned account', () => {
      withSecurity({ allowPasskeys: false })
      assert.equal(
        countAlternativeLogins(withLocal({ password: 'hash', isPasswordKnown: false }), STRATEGY),
        0
      )
    })

    test('does not count when nothing recorded whether it is known', () => {
      withSecurity({ allowPasskeys: false })
      assert.equal(countAlternativeLogins(withLocal({ password: 'hash' }), STRATEGY), 0)
    })

    test('does not count when password login is restricted, known or not', () => {
      withSecurity({ allowPasskeys: false })
      assert.equal(
        countAlternativeLogins(
          withLocal({ password: 'hash', isPasswordKnown: true, restrictLogin: true }),
          STRATEGY
        ),
        0
      )
    })
  })
})
