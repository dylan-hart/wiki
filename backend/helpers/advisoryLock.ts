import { Pool, type PoolConfig } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * A held advisory lock, returned by `acquireAdvisoryLock` for a caller that needs to keep it across
 * more than one function call rather than release it the moment one particular block finishes —
 * `core/db.ts#syncSchemas` is the first such caller, taking the lock itself but handing the handle
 * back up so a wider boot sequence can go on holding it past `syncSchemas()` before finally calling
 * `release()`.
 */
export interface AdvisoryLockHandle {
  /** Unlock and return the underlying client to `pool`. Idempotent to call more than once is NOT
   *  guaranteed — call exactly once, from whichever scope ends up owning the handle last. */
  release(): Promise<void>
}

/**
 * Check a client out of `pool` and take a session-scoped Postgres advisory lock keyed by `key` on it,
 * blocking until any other holder of the same key — in this process or another — releases it first.
 * Returns a handle whose `release()` unlocks and returns the client to `pool`.
 *
 * Unlike `withAdvisoryLock` below, this does not scope the lock to one callback: the caller decides
 * when to let go, which is what lets a lock taken around one step of a sequence (e.g. `syncSchemas()`'s
 * DDL and `migrate()`) be handed off and kept held across later steps a wider caller controls.
 *
 * The lock and its release must run on the exact same physical connection — a `Pool` query checks a
 * connection out and back in per call, so a lock taken through `pool.query()` could be released from a
 * different one and never actually let go. This checks a client out of the pool for the lock's whole
 * lifetime, the same constraint `test/db.ts`'s `createExtensionsSerialized` documents and follows.
 *
 * Blocking (`pg_advisory_lock`) rather than the non-blocking retry/backoff `withAdvisoryLock` below
 * uses: this is a boot-time primitive (`core/db.ts#syncSchemas` is the only caller), taken on a caller-
 * supplied pool before `WIKI.db`/`WIKI.dbManager.config` necessarily exist yet, so there is no request-
 * serving pool connection at risk of being starved the way `withAdvisoryLock`'s doc comment describes.
 */
export async function acquireAdvisoryLock(pool: Pool, key: string): Promise<AdvisoryLockHandle> {
  const client = await pool.connect()
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
  return {
    async release() {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      } finally {
        client.release()
      }
    }
  }
}

/**
 * Run `fn` while holding a session-scoped Postgres advisory lock keyed by `key`, waiting for any other
 * holder of the same key — in this process or another — to release it first.
 *
 * `dispatchStorage` runs as an in-process task (`tasks/simple/dispatch-storage.ts`), but the scheduler
 * still claims and runs several jobs *concurrently* within one process (`processJob`'s
 * `Promise.allSettled`, `core/scheduler.ts`), and a wiki normally runs more than one instance besides —
 * so several jobs targeting the *same* storage target can genuinely interleave, whether that is two
 * `await`s in one process trading off or two processes running at once, with no shared JS memory (or,
 * across instances, no shared process at all) to serialize them with an in-process mutex. For a
 * file-backed module such as `modules/storage/git`, two such jobs both call `ensureRepo()` and then run
 * their own git commands against the same on-disk working copy — a write-path `updated` dispatch racing
 * a scheduled `sync`'s pull/push, say. Two `git` processes touching the same working directory
 * concurrently is exactly the kind of race that leaves a stale `.git/index.lock` neither process cleans
 * up, wedging every future sync until an administrator deletes it by hand: the "unresolvable conflict"
 * class of bug OpenProject #823 (item 7) asks this module be checked against. Locking here, once, at
 * the single choke point every dispatch — content handler or whole-target action — already passes
 * through (`tasks/simple/dispatch-storage.ts`) closes that race for every storage module, not git
 * specifically, at negligible cost: none of these handlers are on a request's critical path, and a
 * second job for the same target simply waits its turn instead of racing.
 *
 * **Never checks a client out of `WIKI.db.$client`, the pool that serves requests.** `fn()` is a
 * storage module handler — a `git push`, an S3 `PUT`, an SFTP transfer, i.e. arbitrarily long network
 * I/O — held for the whole time the lock is held (the lock and its release must run on the exact same
 * physical connection, same constraint `test/db.ts`'s `createExtensionsSerialized` documents and
 * follows). With the request pool's default `max = 10`, one holder plus nine contended callers checked
 * out of that same pool would consume every connection an HTTP request needs, and previously did so by
 * blocking inside `pg_advisory_lock` with no way to give the connection back early (OpenProject #2246).
 * `getLockPool()` below hands out connections from a second, small, dedicated pool instead — cloned
 * from the same connection parameters (`WIKI.dbManager.config`) but capped at `LOCK_POOL_MAX`, so a
 * storm of contended lock attempts can starve only itself, never a request in flight.
 *
 * **Never blocks inside `pg_advisory_lock`.** A contended acquisition instead polls
 * `pg_try_advisory_lock` (non-blocking — returns `false` immediately rather than waiting) on a capped
 * exponential backoff with jitter, and gives up with `AdvisoryLockAcquisitionError` after `maxAttempts`
 * rather than waiting forever. That both bounds how long one lock pool connection can be tied up
 * failing to acquire, and turns a wedged holder (one that took the lock and then hung) into a failed
 * job the scheduler retries with its own backoff — same as any other `dispatchStorage` failure — rather
 * than a silent, indefinite hang. `options` defaults to production-sized values; tests override them to
 * exercise the give-up path without waiting out the real schedule.
 *
 * `hashtext()` collapses `key` to the single bigint `pg_advisory_lock`/`pg_try_advisory_lock` take — a
 * 32-bit hash, so a collision between two different keys is possible in principle. The consequence of
 * one is two unrelated targets occasionally serializing against each other rather than running
 * concurrently, never a correctness problem, so it is not worth a second int32
 * (`pg_advisory_lock(int, int)`) to avoid.
 */

/** Thrown when `withAdvisoryLock` gives up contending for the lock after `maxAttempts` tries. */
export class AdvisoryLockAcquisitionError extends Error {
  constructor(key: string, attempts: number) {
    super(`Gave up acquiring advisory lock "${key}" after ${attempts} attempt(s)`)
    this.name = 'AdvisoryLockAcquisitionError'
  }
}

export interface AdvisoryLockOptions {
  /** Total `pg_try_advisory_lock` attempts before giving up. Default: 10. */
  maxAttempts?: number
  /** Delay before the second attempt; doubles each attempt after, capped by `maxDelayMs`. Default: 100. */
  baseDelayMs?: number
  /** Ceiling on the backoff delay between attempts, before jitter. Default: 3000. */
  maxDelayMs?: number
}

const LOCK_POOL_DEFAULTS: Required<AdvisoryLockOptions> = {
  maxAttempts: 10,
  baseDelayMs: 100,
  maxDelayMs: 3000
}

/**
 * A handful of concurrent lock holders/contenders is the expected ceiling for this pool — nothing else
 * ever draws from it — so it stays small deliberately, unlike the request-serving pool's `max`.
 */
const LOCK_POOL_MAX = 4

let lockPool: Pool | null = null

/**
 * Lazily build the dedicated advisory-lock pool from the same connection parameters the main pool was
 * built from (`WIKI.dbManager.config`, populated once `dbManager.init()` has run — always true by the
 * time any job dispatches a lock, since nothing during boot itself calls `withAdvisoryLock`).
 *
 * Every real boot path (`index.ts`, `mcp/bootstrap.ts`, `migration/bootstrap.ts`,
 * `scripts/audit-site-scoped-rules.ts`) sets `WIKI.dbManager` to the real `core/db.ts` module and
 * always calls `dbManager.init()` before `WIKI.db` is usable, so `WIKI.dbManager.config` is always
 * present by the time production code gets here. A lightweight test harness can legitimately build
 * `WIKI.db` directly (a plain `drizzle({ client: pool, ... })`) without ever running `dbManager.init()`
 * — for that shape only, fall back to reusing `WIKI.db.$client` itself rather than throwing on
 * `WIKI.dbManager` (or its `.config`) being absent. This is not a legacy shim: production always takes
 * the primary branch, since `WIKI.dbManager` is unconditionally populated during boot.
 */
function getLockPool(): Pool {
  if (!lockPool) {
    lockPool = WIKI.dbManager?.config
      ? new Pool({
          ...(WIKI.dbManager.config as PoolConfig),
          application_name: `Cardinal.js - ${WIKI.INSTANCE_ID}:LOCKS`,
          max: LOCK_POOL_MAX
        })
      : (WIKI.db.$client as Pool)
  }
  return lockPool
}

/**
 * Test-only: drop the cached pool so a suite can rebuild it against its own `DATABASE_URL`/config, and
 * close it in `after()` so the process can exit.
 *
 * Tolerates a pool that has already been ended by whoever constructed it — the fallback branch of
 * `getLockPool()` above can hand back a pool object a test owns and closes directly (e.g.
 * `WIKI.db.$client`), so by the time a later test resets the cache, `.end()` on it may already have
 * run. This only needs to guarantee the module-level cache itself is cleared, not that it is the one
 * to close the connection.
 */
export async function _resetLockPoolForTests(): Promise<void> {
  if (lockPool) {
    try {
      await lockPool.end()
    } catch {
      // -> Already ended elsewhere -- see doc comment above.
    }
    lockPool = null
  }
}

function jitteredDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
  return backoff + Math.random() * backoff * 0.25
}

export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...LOCK_POOL_DEFAULTS, ...options }
  const pool = getLockPool()
  const client = await pool.connect()
  // -> Set when the unlock query itself fails, so the outer `finally` knows the connection's lock
  //    state is uncertain and must discard it rather than return it to the pool.
  let unlockFailed = false
  try {
    let attempt = 0
    for (;;) {
      attempt++
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [key]
      )
      if (res.rows[0].locked) {
        break
      }
      if (attempt >= maxAttempts) {
        throw new AdvisoryLockAcquisitionError(key, attempt)
      }
      await delay(jitteredDelay(attempt, baseDelayMs, maxDelayMs))
    }
    try {
      return await fn()
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      } catch (err: any) {
        // -> Never rethrow here: an abrupt completion from a `finally` replaces whatever `fn` was
        //    propagating, and `fn`'s own error (most likely the same dead connection) is the one the
        //    caller needs — see `dispatch-storage.ts`, which rethrows to drive `jobHistory` state.
        unlockFailed = true
        WIKI.logger.warn('db', 'releasing an advisory lock failed, discarding the connection', {
          key,
          error: err
        })
      }
    }
  } finally {
    // -> `true` destroys the connection instead of returning it to the pool. When the unlock failed
    //    the session may still be alive and still hold the lock (`pg_advisory_lock` is re-entrant per
    //    session), so a returned connection would hand a later borrower the lock for free while every
    //    other session blocks on it forever.
    client.release(unlockFailed)
  }
}
