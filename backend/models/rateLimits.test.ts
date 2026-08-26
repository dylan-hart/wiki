import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

/**
 * `consume()` is a single hand-written upsert whose CASE arms decide window rollover, ban issuance
 * and ban expiry atomically — exactly the kind of SQL orchestration `models/pages.test.ts` and
 * `models/auditLog.test.ts` run against a real, migrated database rather than mocking the query
 * builder. `helpers/rateLimit.test.ts` stubs `consume` deliberately (it tests the Fastify hook, not
 * the counting logic) — this file is where the counting logic itself gets exercised.
 *
 * Each test uses its own `key`, since every test in this suite shares one database/schema and rows
 * are keyed by `key` alone (see `db/schema.ts#rateLimits`).
 */
describe('rateLimits consume/reset/purgeStale (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let rateLimitsModel: typeof import('./rateLimits.ts').rateLimits

  before(async () => {
    fixtures = await setupTestDb()
    ;({ rateLimits: rateLimitsModel } = await import('./rateLimits.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('allows max consecutive attempts, hits counting 1..max', async () => {
    const policy: RateLimitPolicy = { max: 3, windowSeconds: 60, banSeconds: 60 }
    const key = 'test:consecutive'

    for (let i = 1; i <= policy.max; i++) {
      const verdict = await rateLimitsModel.consume(key, policy)
      assert.equal(verdict.allowed, true, `attempt ${i} should be allowed`)
      assert.equal(verdict.hits, i)
      assert.equal(verdict.retryAfter, 0)
    }
  })

  test('the (max+1)-th attempt is refused with a non-zero retryAfter', async () => {
    const policy: RateLimitPolicy = { max: 2, windowSeconds: 60, banSeconds: 60 }
    const key = 'test:over-limit'

    await rateLimitsModel.consume(key, policy)
    await rateLimitsModel.consume(key, policy)
    const verdict = await rateLimitsModel.consume(key, policy)

    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfter > 0, `expected a positive retryAfter, got ${verdict.retryAfter}`)
    assert.ok(verdict.retryAfter <= policy.banSeconds)
  })

  test(
    'further attempts during the ban leave bannedUntil unchanged: retryAfter only decreases, ' +
      'never resets to banSeconds',
    async () => {
      const policy: RateLimitPolicy = { max: 1, windowSeconds: 60, banSeconds: 3 }
      const key = 'test:still-banned'

      // First attempt is allowed and consumes the whole budget; the second earns the ban.
      await rateLimitsModel.consume(key, policy)
      const banned = await rateLimitsModel.consume(key, policy)
      assert.equal(banned.allowed, false)
      assert.ok(banned.retryAfter > 0)

      let previousRetryAfter = banned.retryAfter
      for (let i = 0; i < 3; i++) {
        await sleep(700)
        const verdict = await rateLimitsModel.consume(key, policy)
        assert.equal(
          verdict.allowed,
          false,
          `attempt while still banned (round ${i}) should refuse`
        )
        // -> The sharpest assertion: a still-banned attempt must never push retryAfter back up to
        //    banSeconds (which would mean bannedUntil got extended by the attempt itself, rather than
        //    the "still banned" CASE arm leaving it untouched).
        assert.ok(
          verdict.retryAfter <= previousRetryAfter,
          `retryAfter should not increase while banned: was ${previousRetryAfter}, now ${verdict.retryAfter}`
        )
        assert.notEqual(verdict.retryAfter, policy.banSeconds)
        previousRetryAfter = verdict.retryAfter
      }
    }
  )

  test('a call after the ban expires starts a fresh window at hits: 1', async () => {
    const policy: RateLimitPolicy = { max: 1, windowSeconds: 60, banSeconds: 1 }
    const key = 'test:post-ban'

    await rateLimitsModel.consume(key, policy)
    const banned = await rateLimitsModel.consume(key, policy)
    assert.equal(banned.allowed, false)

    // Wait out the ban, then a little more so `bannedUntil > now()` is unambiguously false.
    await sleep((policy.banSeconds + 1) * 1000)

    const afterBan = await rateLimitsModel.consume(key, policy)
    assert.equal(afterBan.allowed, true)
    assert.equal(afterBan.hits, 1)
    assert.equal(afterBan.retryAfter, 0)
  })

  test('max + 5 concurrent attempts on one key yield exactly max allowed verdicts', async () => {
    const policy: RateLimitPolicy = { max: 5, windowSeconds: 60, banSeconds: 60 }
    const key = 'test:concurrent'

    const verdicts = await Promise.all(
      Array.from({ length: policy.max + 5 }, () => rateLimitsModel.consume(key, policy))
    )

    const allowedCount = verdicts.filter((v) => v.allowed).length
    assert.equal(
      allowedCount,
      policy.max,
      'the upsert must serialize concurrent attempts so exactly `max` are ever allowed'
    )

    const hitsSeen = verdicts.map((v) => v.hits).sort((a, b) => a - b)
    assert.deepEqual(
      hitsSeen.slice(0, policy.max),
      Array.from({ length: policy.max }, (_, i) => i + 1),
      'the allowed attempts should account for hits 1..max between them'
    )
  })

  test('reset() forgets a key: the next attempt starts a fresh window', async () => {
    const policy: RateLimitPolicy = { max: 1, windowSeconds: 60, banSeconds: 60 }
    const key = 'test:reset'

    await rateLimitsModel.consume(key, policy)
    const banned = await rateLimitsModel.consume(key, policy)
    assert.equal(banned.allowed, false)

    await rateLimitsModel.reset(key)

    const afterReset = await rateLimitsModel.consume(key, policy)
    assert.equal(afterReset.allowed, true)
    assert.equal(afterReset.hits, 1)
  })

  test('purgeStale() drops rows untouched for a day, leaves recent rows alone', async () => {
    const policy: RateLimitPolicy = { max: 5, windowSeconds: 60, banSeconds: 60 }
    const freshKey = 'test:purge-fresh'
    const staleKey = 'test:purge-stale'

    await rateLimitsModel.consume(freshKey, policy)
    await rateLimitsModel.consume(staleKey, policy)

    // Backdate the stale row's updatedAt past the 1-day cutoff `purgeStale()` uses.
    await fixtures.db.execute(
      `update "rateLimits" set "updatedAt" = now() - interval '2 days' where "key" = '${staleKey}'`
    )

    const purged = await rateLimitsModel.purgeStale()
    assert.equal(purged, 1)

    // The stale row is gone, so the next attempt on that key starts fresh at hits: 1.
    const afterPurge = await rateLimitsModel.consume(staleKey, policy)
    assert.equal(afterPurge.hits, 1)

    // The fresh row survived: its next attempt continues the same window at hits: 2.
    const stillFresh = await rateLimitsModel.consume(freshKey, policy)
    assert.equal(stillFresh.hits, 2)
  })
})
