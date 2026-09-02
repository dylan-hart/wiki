import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { userCredentials } from './userCredentials.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * OpenProject #1653: `validateToken()` reads `validUntil` back from a `timestamp` (no time zone)
 * column, so its correctness depends on how the `pg` driver reconstructs the resulting `Date` under
 * the Node process's local `TZ` -- see `docs/audit-2026-08-24/correctness-data-schema.md` §2, and the
 * epic this work package is part of (converting every such column to `timestamptz`). The defect is
 * invisible on a UTC host, which is exactly why it needs coverage that runs off UTC: this suite runs
 * under `TZ=America/New_York` for its duration.
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
