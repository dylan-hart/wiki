import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { withAdvisoryLock, _resetLockPoolForTests } from './advisoryLock.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * `withAdvisoryLock` holds a client for the whole of `fn`, so an `fn` that needs a second connection
 * from the same pool deadlocks once as many holders as the pool has connections are all mid-`fn` —
 * which is why `tasks/simple/dispatch-storage.ts` records its outcome after the lock callback
 * returns, not inside it.
 *
 * `runConcurrentDispatches` supplies only `CARDINAL.db.$client`, no `CARDINAL.dbManager`, so
 * `getLockPool()` falls back to that pool and the lock connection and the inner query share it.
 * `connectionTimeoutMillis` makes the exhaustion surface as a rejection instead of hanging the suite.
 */

const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance, no migrations needed)'

/**
 * Distinct keys, so the holders contend for the pool only, never for a lock. The barrier keeps every
 * holder inside `fn` until all have entered, so the inner queries start against a fully checked-out
 * pool however long each outer connection took to establish.
 */
async function runConcurrentDispatches(pool: Pool, count: number) {
  installTestWiki({ db: { $client: pool } })
  // -> `getLockPool()` caches its pool at module scope; without this the second test would reuse
  //    the first test's already-ended pool.
  await _resetLockPoolForTests()

  let entered = 0
  let releaseBarrier: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })
  const observedAtBarrier = { total: -1, idle: -1, waiting: -1 }

  const dispatch = (i: number) =>
    withAdvisoryLock(`pool-exhaustion-test-${count}-${i}`, async () => {
      entered++
      if (entered === count) {
        observedAtBarrier.total = pool.totalCount
        observedAtBarrier.idle = pool.idleCount
        observedAtBarrier.waiting = pool.waitingCount
        releaseBarrier()
      }
      await barrier

      // -> The second connection, requested from the same pool while `fn` still holds the first.
      const client = await pool.connect()
      try {
        await client.query('SELECT 1')
      } finally {
        client.release()
      }
    })

  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => dispatch(i)))
  return { results, observedAtBarrier }
}

describe('advisory-lock pool exhaustion (OpenProject #2243 reproduction)', () => {
  test(
    'a burst of concurrent dispatches sized to the pool deadlocks the record-success-shaped query every one of them still needs to make',
    { skip },
    async () => {
      const CONCURRENCY = 4
      const pool = new Pool({
        connectionString: DATABASE_URL,
        max: CONCURRENCY,
        connectionTimeoutMillis: 2000
      })

      try {
        const { results, observedAtBarrier } = await runConcurrentDispatches(pool, CONCURRENCY)

        assert.equal(observedAtBarrier.total, CONCURRENCY, 'pool should be fully checked out')
        assert.equal(observedAtBarrier.idle, 0, 'no connection should be free at that instant')

        assert.equal(
          results.filter((r) => r.status === 'rejected').length,
          CONCURRENCY,
          `expected every dispatch's inner query to be starved out, got ${JSON.stringify(results)}`
        )
        for (const r of results) {
          assert.equal(r.status, 'rejected')
          assert.match((r as PromiseRejectedResult).reason.message, /timeout exceeded/i)
        }
      } finally {
        await pool.end()
      }
    }
  )

  test(
    'the same burst does not deadlock once the pool has headroom beyond the concurrency',
    { skip },
    async () => {
      const CONCURRENCY = 4
      const pool = new Pool({
        connectionString: DATABASE_URL,
        // -> Spare connections let the inner queries cascade through: the deadlock is pool size
        //    against concurrency, not a slow database.
        max: CONCURRENCY + 2,
        connectionTimeoutMillis: 2000
      })

      try {
        const { results } = await runConcurrentDispatches(pool, CONCURRENCY)

        assert.equal(
          results.filter((r) => r.status === 'fulfilled').length,
          CONCURRENCY,
          `expected every dispatch to complete once the pool has headroom, got ${JSON.stringify(results)}`
        )
      } finally {
        await pool.end()
      }
    }
  )
})
