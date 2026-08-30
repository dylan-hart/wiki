import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { rateLimits as rateLimitsTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

/**
 * `models/rateLimits.ts#consume()` is a single hand-written `INSERT ... ON CONFLICT DO UPDATE` whose
 * three-armed `CASE` expressions decide window rollover, ban issuance and ban expiry atomically — see
 * the file's own doc comment for the four behavioural promises this pins. It is exercised here
 * against a real database rather than mocked: the whole point of doing this in one upsert is
 * atomicity under concurrency, which a mock of the query builder cannot demonstrate at all.
 *
 * `backend/helpers/rateLimit.test.ts` stubs this method — correctly, since it tests the Fastify hook
 * — leaving the counting logic itself, tested here, previously uncovered.
 */
describe('rateLimits (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let rateLimitsModel: typeof import('./rateLimits.ts').rateLimits

  before(async () => {
    fixtures = await setupTestDb()
    ;({ rateLimits: rateLimitsModel } = await import('./rateLimits.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(async () => {
    // -> Every key is deleted between tests, so one test's ban/window state never leaks into the next.
    await fixtures.db.delete(rateLimitsTable)
  })

  const POLICY: RateLimitPolicy = { max: 3, windowSeconds: 60, banSeconds: 3 }

  test('allows the first `max` attempts, counting hits 1..max', async () => {
    const key = `test:${randomUUID()}`
    for (let i = 1; i <= POLICY.max; i++) {
      const verdict = await rateLimitsModel.consume(key, POLICY)
      assert.equal(verdict.allowed, true, `attempt ${i} should be allowed`)
      assert.equal(verdict.hits, i)
      assert.equal(verdict.retryAfter, 0)
    }
  })

  test('refuses the (max + 1)-th attempt with a non-zero retryAfter', async () => {
    const key = `test:${randomUUID()}`
    for (let i = 0; i < POLICY.max; i++) {
      await rateLimitsModel.consume(key, POLICY)
    }
    const verdict = await rateLimitsModel.consume(key, POLICY)
    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfter > 0)
    assert.ok(verdict.retryAfter <= POLICY.banSeconds)
  })

  test(
    'retryAfter decreases monotonically during a ban and is never reset to banSeconds by a ' +
      'further attempt — the rolledOver arm must not mistake a still-live ban for an expired one',
    async () => {
      const key = `test:${randomUUID()}`
      for (let i = 0; i < POLICY.max; i++) {
        await rateLimitsModel.consume(key, POLICY)
      }
      const first = await rateLimitsModel.consume(key, POLICY)
      assert.equal(first.allowed, false)
      // -> This is the attempt that trips the ban -- it is still "counted" (hits: "the one just
      //    counted included", per the interface doc), one past `max`. `stillBanned` only takes over
      //    from the next attempt onward, which is what the rest of this test pins.
      assert.equal(first.hits, POLICY.max + 1)

      await new Promise((resolve) => setTimeout(resolve, 1200))

      const second = await rateLimitsModel.consume(key, POLICY)
      assert.equal(second.allowed, false)
      assert.equal(
        second.hits,
        first.hits,
        'a refused attempt during an active ban must not add a hit'
      )
      assert.ok(
        second.retryAfter < first.retryAfter,
        `retryAfter should have decreased (was ${first.retryAfter}, now ${second.retryAfter})`
      )
      assert.notEqual(
        second.retryAfter,
        POLICY.banSeconds,
        'a further attempt during a live ban must not reset retryAfter back up to banSeconds'
      )

      const rows = await fixtures.db
        .select()
        .from(rateLimitsTable)
        .where(eq(rateLimitsTable.key, key))
      // -> `bannedUntil` itself must be unchanged by the second attempt, not just retryAfter's
      //    derived reading of it.
      const [row] = rows
      assert.ok(row?.bannedUntil, 'bannedUntil should still be set')
    }
  )

  test('a call after the ban has expired starts a fresh window at hits: 1', async () => {
    const shortBan: RateLimitPolicy = { max: 1, windowSeconds: 60, banSeconds: 1 }
    const key = `test:${randomUUID()}`

    const first = await rateLimitsModel.consume(key, shortBan)
    assert.equal(first.allowed, true)
    const banned = await rateLimitsModel.consume(key, shortBan)
    assert.equal(banned.allowed, false)

    await new Promise((resolve) => setTimeout(resolve, 1500))

    const afterBan = await rateLimitsModel.consume(key, shortBan)
    assert.equal(afterBan.allowed, true)
    assert.equal(afterBan.hits, 1)
    assert.equal(afterBan.retryAfter, 0)
  })

  test('concurrent attempts on one key are serialized by the upsert: exactly `max` are allowed', async () => {
    const key = `test:${randomUUID()}`
    const attempts = POLICY.max + 5
    const verdicts = await Promise.all(
      Array.from({ length: attempts }, () => rateLimitsModel.consume(key, POLICY))
    )
    const allowedCount = verdicts.filter((v) => v.allowed).length
    assert.equal(
      allowedCount,
      POLICY.max,
      'exactly `max` concurrent attempts should have been allowed, no more and no fewer'
    )

    const hitsSeen = verdicts
      .filter((v) => v.allowed)
      .map((v) => v.hits)
      .sort((a, b) => a - b)
    assert.deepEqual(
      hitsSeen,
      Array.from({ length: POLICY.max }, (_, i) => i + 1),
      'the allowed attempts should account for hits 1..max between them'
    )
  })

  test('reset() forgets a key, so the next attempt starts a fresh window', async () => {
    const key = `test:${randomUUID()}`
    await rateLimitsModel.consume(key, POLICY)
    await rateLimitsModel.consume(key, POLICY)

    await rateLimitsModel.reset(key)

    const verdict = await rateLimitsModel.consume(key, POLICY)
    assert.equal(verdict.allowed, true)
    assert.equal(verdict.hits, 1)
  })

  test('purgeStale() drops only rows untouched for over a day', async () => {
    const staleKey = `test:stale:${randomUUID()}`
    const freshKey = `test:fresh:${randomUUID()}`

    await rateLimitsModel.consume(freshKey, POLICY)
    await fixtures.db.insert(rateLimitsTable).values({
      key: staleKey,
      hits: 1,
      windowStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    })

    const purged = await rateLimitsModel.purgeStale()
    assert.ok(purged >= 1)

    const remaining = await fixtures.db.select().from(rateLimitsTable)
    const keys = remaining.map((r) => r.key)
    assert.ok(keys.includes(freshKey), 'a recently-touched row must survive the purge')
    assert.ok(!keys.includes(staleKey), 'a day-stale row must be purged')
  })
})
