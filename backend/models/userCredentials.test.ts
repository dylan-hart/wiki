import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { matchRecoveryCode } from './userCredentials.ts'
import type { RecoveryCodeEntry } from './userCredentials.ts'

/**
 * `matchRecoveryCode` is the constant-time-discipline core of recovery-code verification, split out
 * of `verifyAndConsumeRecoveryCode` precisely so it can be tested without `WIKI` or a database: given
 * a set of stored entries and a normalized code, which one (if any) matches. Hashed with a low
 * `bcrypt` cost here purely for test speed — the function itself takes whatever cost is baked into
 * each stored hash, same as production.
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
