import { Pool, type PoolConfig } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

export interface AdvisoryLockHandle {
  /** Not idempotent: call exactly once, from whichever scope ends up owning the handle. */
  release(): Promise<void>
}

/**
 * Unlike `withAdvisoryLock`, the caller decides when to let go, so a lock taken around one boot step
 * can stay held across later ones.
 *
 * A session-scoped lock must be released on the connection that took it, and `pool.query()` checks
 * one out per call, so a client is held for the lock's whole lifetime.
 *
 * Blocks in `pg_advisory_lock` rather than polling as `withAdvisoryLock` does: this is a boot-time
 * primitive, used before the server accepts requests, so a waiting connection starves nobody.
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

export class AdvisoryLockAcquisitionError extends Error {
  constructor(key: string, attempts: number) {
    super(`Gave up acquiring advisory lock "${key}" after ${attempts} attempt(s)`)
    this.name = 'AdvisoryLockAcquisitionError'
  }
}

export interface AdvisoryLockOptions {
  maxAttempts?: number
  /** Delay before the second attempt; doubles each attempt after, capped by `maxDelayMs`. */
  baseDelayMs?: number
  /** Caps the backoff before jitter is added. */
  maxDelayMs?: number
}

const LOCK_POOL_DEFAULTS: Required<AdvisoryLockOptions> = {
  maxAttempts: 10,
  baseDelayMs: 100,
  maxDelayMs: 3000
}

/**
 * The lock pool is dedicated and small, never `CARDINAL.db.$client`: a connection is held for the
 * whole of `fn`, which can be arbitrarily long network I/O, and every contender holds one while it
 * polls. Drawn from the request pool, a burst of them could take every connection HTTP requests
 * need; capped here, it can starve only itself.
 */
const LOCK_POOL_MAX = 4

let lockPool: Pool | null = null

/**
 * The `CARDINAL.db.$client` fallback is for a test harness that builds `CARDINAL.db` without running
 * `dbManager.init()`; every real boot path populates `CARDINAL.dbManager.config` first.
 */
function getLockPool(): Pool {
  if (!lockPool) {
    lockPool = CARDINAL.dbManager?.config
      ? new Pool({
          ...(CARDINAL.dbManager.config as PoolConfig),
          application_name: `Cardinal.js - ${CARDINAL.INSTANCE_ID}:LOCKS`,
          max: LOCK_POOL_MAX
        })
      : (CARDINAL.db.$client as Pool)
  }
  return lockPool
}

/**
 * Test-only. Tolerates a pool its owner has already ended: `getLockPool()`'s fallback branch caches a
 * pool the test itself constructed and closes.
 */
export async function _resetLockPoolForTests(): Promise<void> {
  if (lockPool) {
    try {
      await lockPool.end()
    } catch {
      // -> Already ended by its owner.
    }
    lockPool = null
  }
}

function jitteredDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
  return backoff + Math.random() * backoff * 0.25
}

/**
 * Serializes holders of `key` across processes as well as within one, which an in-process mutex
 * cannot.
 *
 * Polls `pg_try_advisory_lock` on a capped, jittered backoff and gives up with
 * `AdvisoryLockAcquisitionError`, rather than blocking in `pg_advisory_lock`: that bounds how long a
 * lock-pool connection is tied up, and turns a wedged holder into a failure the caller can retry
 * instead of a silent hang.
 *
 * `hashtext()` is 32-bit, so two keys can collide. They then merely serialize against each other,
 * which is not worth `pg_advisory_lock(int, int)` to avoid.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...LOCK_POOL_DEFAULTS, ...options }
  const pool = getLockPool()
  const client = await pool.connect()
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
        // -> Never rethrow: an abrupt completion from a `finally` would replace the error `fn` is
        //    propagating, which is the one the caller needs.
        unlockFailed = true
        CARDINAL.logger.warn('db', 'releasing an advisory lock failed, discarding the connection', {
          key,
          error: err
        })
      }
    }
  } finally {
    // -> `true` destroys the connection. After a failed unlock the session may still hold the lock
    //    (advisory locks are re-entrant per session), so a pooled connection would hand a later
    //    borrower the lock for free while every other session is refused it.
    client.release(unlockFailed)
  }
}
