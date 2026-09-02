import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { withAdvisoryLock, _resetLockPoolForTests } from './advisoryLock.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Reproduction for OpenProject #2243 (child of #2242, from `docs/audit-2026-08-24/security/
 * 12-infrastructure-ops.md` §2): does a burst of concurrent `dispatchStorage` dispatches genuinely
 * exhaust a single shared Postgres pool and deadlock `recordSuccess`/`recordFailure`, or is the
 * co-occurrence the audit flagged as unverified actually unreachable?
 *
 * Rather than standing up a full running instance with a real (deliberately stalled) git/SFTP target
 * and a bulk import to drive it — non-deterministic, slow, and not something a repeatable, CI-shaped
 * test can assert against — this reproduces the *mechanism* directly, using the real
 * `withAdvisoryLock` unmodified against a real Postgres pool:
 *
 *   - `tasks/simple/dispatch-storage.ts` calls `withAdvisoryLock(key, fn)`, which checks a client out
 *     of a pool for the *entire* duration of `fn` — not just the lock/unlock queries
 *     (`helpers/advisoryLock.ts`).
 *   - `fn` runs the storage module's handler (the slow part — a git push, an SFTP upload) and then,
 *     on success or failure, calls `contentSync.recordSuccess`/`recordFailure`, which is a second,
 *     independent query issued from *inside* the still-held `fn`.
 *   - `core/scheduler.ts`'s `processJob` claims and runs up to `maxWorkers` jobs concurrently via
 *     `Promise.allSettled`. Because `dispatchStorage` is an in-process task, each concurrent job's
 *     `withAdvisoryLock` call checks out its own pool connection independently.
 *
 * So: if `maxWorkers` concurrent `dispatchStorage` jobs are all mid-`fn` (each holding one pool
 * connection for its slow handler call) at the moment the pool has no free connections left, then the
 * moment any of them reaches its `recordSuccess`/`recordFailure` call, that call needs a *new*
 * connection from a pool with nothing free — and nothing *can* free one, because every other holder
 * is in the exact same position, blocked on its own such call. That is a genuine deadlock, not mere
 * contention: `base.yml`'s `pool: { min: 1 }` is the whole of the shipped pool config, so no `max` and
 * no `connectionTimeoutMillis` are set, and pg's own default for the latter is `0` (wait forever) — a
 * real occurrence of this would hang the affected jobs (and the connections they hold) indefinitely,
 * not merely slow them down.
 *
 * `withAdvisoryLock`'s own dedicated lock pool (`getLockPool()`, `helpers/advisoryLock.ts`) normally
 * clones a *separate*, small pool from `WIKI.dbManager.config` specifically so the lock-holding
 * connection can never contend with request-serving traffic (OpenProject #2246) — which would decouple
 * the outer lock connection from an inner query issued against a different pool entirely, and this
 * reproduction wants both on the *same* pool, exactly as `dispatchStorage`'s handler-plus-recordSuccess
 * sequence draws both from `WIKI.db`. `runConcurrentDispatches` below deliberately supplies only
 * `WIKI.db.$client`, no `WIKI.dbManager` — `getLockPool()`'s documented fallback for that shape reuses
 * `WIKI.db.$client` itself as the lock pool, rather than cloning a new one, so the outer connection and
 * the inner "recordSuccess" query genuinely share the one pool this reproduction constructs and
 * measures. `_resetLockPoolForTests()` clears that module-cached pool between the two tests below, each
 * of which supplies its own differently-sized pool.
 *
 * The two tests below drive exactly that scenario against a real pool, with an explicit barrier (not
 * fixed sleeps) synchronizing every holder's entry to `fn` before any of them attempts its inner
 * "recordSuccess" query — the instant that genuinely matters for exhaustion. `connectionTimeoutMillis`
 * is set on the *test's own pool only*, so the exhaustion below resolves as an observable rejection
 * within the test run instead of hanging the suite; it is not a claim about — or a stealth fix for —
 * production, which has no such backstop today (see #2243's parent epic, #2242, for the sizing work
 * this reproduction's result is meant to inform).
 */

const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance, no migrations needed)'

/**
 * Runs `count` concurrent `withAdvisoryLock` holders (distinct keys — no lock contention between
 * them, only pool contention) against `pool`, each holder's `fn`:
 *   1. Recording that it has entered `fn` (this is where the real code's slow storage-handler call
 *      would run) and, once every holder has done so, releasing a shared barrier.
 *   2. Awaiting that barrier, so every holder attempts its inner query at effectively the same
 *      instant regardless of how long establishing its own outer connection took.
 *   3. Issuing a second query against the *same* pool — standing in for `recordSuccess`/
 *      `recordFailure`, called from inside `fn` after the storage handler settles.
 *
 * Returns the `Promise.allSettled` results plus the pool's own connection counts observed at the
 * barrier (every holder in `fn`, none yet attempting its inner query) — the "observed pool state" a
 * written reproduction needs to record.
 */
async function runConcurrentDispatches(pool: Pool, count: number) {
  installTestWiki({ db: { $client: pool } })
  // -> `getLockPool()` caches its pool at module scope; without this, the second test in this file
  //    would reuse the first test's already-`.end()`-ed pool instead of picking up its own.
  await _resetLockPoolForTests()

  let entered = 0
  let releaseBarrier: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })
  const observedAtBarrier = { total: -1, idle: -1, waiting: -1 }

  const dispatch = (i: number) =>
    withAdvisoryLock(`pool-exhaustion-test-${count}-${i}`, async () => {
      // -> Stands in for `mod[handler](target, data)` in `tasks/simple/dispatch-storage.ts`: the slow
      //    storage-module call that keeps the outer connection checked out for its whole duration.
      entered++
      if (entered === count) {
        observedAtBarrier.total = pool.totalCount
        observedAtBarrier.idle = pool.idleCount
        observedAtBarrier.waiting = pool.waitingCount
        releaseBarrier()
      }
      await barrier

      // -> Stands in for `contentSyncDep.recordSuccess(...)`/`recordFailure(...)` immediately after:
      //    a second query against the same shared pool, issued from inside the still-locked `fn`.
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
        // -> Test-only backstop — see file header. Production sets none.
        connectionTimeoutMillis: 2000
      })

      try {
        const { results, observedAtBarrier } = await runConcurrentDispatches(pool, CONCURRENCY)

        // Observed pool state the instant every one of the CONCURRENCY holders had entered `fn` and
        // checked its own connection out, before any of them attempted its inner query:
        assert.equal(observedAtBarrier.total, CONCURRENCY, 'pool should be fully checked out')
        assert.equal(observedAtBarrier.idle, 0, 'no connection should be free at that instant')

        // Every inner "recordSuccess"-shaped attempt had to queue behind a pool with zero free
        // connections — and nothing could free one, since every one of the CONCURRENCY holders was
        // blocked on that exact same inner query. All CONCURRENCY attempts reject only because this
        // test's pool has a `connectionTimeoutMillis`; a real instance, with none configured, would
        // have every one of these jobs (and the connections they hold) hang indefinitely instead.
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
        // -> Two spare connections beyond what the burst needs to hold open — enough for the inner
        //    queries to cascade through without ever fully starving, isolating that this is a
        //    concurrency-vs-pool-size relationship, not "the database was simply slow."
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
