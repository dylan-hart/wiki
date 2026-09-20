import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { userCredentials } from './userCredentials.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * `validateToken()` reads `validUntil` back from a `timestamp` (no time zone) column, so it depends
 * on how the `pg` driver reconstructs that `Date` under the process's local `TZ` — a mismatch is
 * invisible on a UTC host, hence `TZ=America/New_York` for this suite's duration.
 */
describe(
  'userCredentials.generateToken / validateToken under a non-UTC TZ (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let previousTz: string | undefined

    before(async () => {
      previousTz = process.env.TZ
      process.env.TZ = 'America/New_York'
      await ensureTemporal()
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
      if (previousTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previousTz
      }
    })

    test('a token issued moments ago validates as not-yet-expired, even off UTC', async () => {
      const token = await userCredentials.generateToken({ kind: 'verify', userId: fixtures.userId })

      const result = await userCredentials.validateToken({
        kind: 'verify',
        token,
        skipDelete: true
      })

      assert.ok(
        result,
        'expected the fresh token to validate, not throw ERR_EXPIRED_VALIDATION_TOKEN'
      )
      assert.equal(result.user.id, fixtures.userId)
    })
  }
)
