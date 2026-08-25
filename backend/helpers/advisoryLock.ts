import type { Pool } from 'pg'

/**
 * Run `fn` while holding a session-scoped Postgres advisory lock keyed by `key`, blocking until any
 * other holder of the same key — in this process or another — releases it first.
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
 * The lock and its release must run on the exact same physical connection — a `Pool` query checks a
 * connection out and back in per call, so a lock taken through `pool.query()` could be released from a
 * different one and never actually let go. This checks a client out of the pool for the duration of
 * `fn`, the same constraint `test/db.ts`'s `createExtensionsSerialized` documents and follows.
 *
 * `hashtext()` collapses `key` to the single bigint `pg_advisory_lock` takes — a 32-bit hash, so a
 * collision between two different keys is possible in principle. The consequence of one is two
 * unrelated targets occasionally serializing against each other rather than running concurrently,
 * never a correctness problem, so it is not worth a second int32 (`pg_advisory_lock(int, int)`) to
 * avoid.
 *
 * Acquisition is bounded by a session-level `lock_timeout` on this same connection: `pg_advisory_lock`
 * itself blocks forever with nothing else in this codebase setting a `lock_timeout`, so a wedged
 * holder (a dead peer, a hung `fn` from an earlier, still-in-flight call) would otherwise strand this
 * caller — and the worker slot or scheduler tick it runs on — indefinitely. A timed-out acquisition
 * throws like any other Postgres error and releases the connection normally, since the lock was never
 * taken. Deliberately `SET`, not `SET LOCAL`: this client issues each statement as its own separate
 * query with no enclosing `BEGIN`, and Postgres runs an unwrapped statement in its own implicit
 * transaction that ends the instant it finishes — so a `SET LOCAL` here would revert before the very
 * next statement (the lock acquisition itself) ever saw it, silently leaving the wait unbounded again.
 * The session-level `SET` takes effect immediately and stays in effect for the rest of this
 * connection's life, which is exactly why it is reset back to `DEFAULT` before a clean release below:
 * left set, a 30s `lock_timeout` would leak onto whatever unrelated query the pool next hands this
 * connection to.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000

export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pool = WIKI.db.$client as Pool
  const client = await pool.connect()
  let releaseCleanly = true
  try {
    await client.query(`SET lock_timeout = ${LOCK_ACQUIRE_TIMEOUT_MS}`)
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
    try {
      return await fn()
    } finally {
      // -> The unlock is awaited in its own try/catch, never a bare `finally`: an abrupt completion
      //    from a `finally` replaces the error `fn` is already propagating, so if the connection died
      //    mid-`fn` — the situation `fn` most likely just threw for — the caller would see the
      //    unlock's error instead of the real one. Swallow it here (logged, not silent) and let
      //    `releaseCleanly` tell the outer `finally` whether the lock's state on this connection is
      //    still trustworthy.
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
        // -> Reset the session GUC before this connection can go back to the pool for reuse by
        //    unrelated code -- see this function's own doc comment for why `lock_timeout` is set at
        //    session scope in the first place.
        await client.query('SET lock_timeout = DEFAULT')
      } catch (err: any) {
        releaseCleanly = false
        WIKI.logger.warn(
          `Failed to release advisory lock ${key}, discarding the connection: ${err.message}`
        )
      }
    }
  } finally {
    // -> `client.release(true)` when the unlock (or the GUC reset following it) could not be
    //    confirmed: `pg_advisory_lock` is re-entrant per session, so recycling a connection whose lock
    //    state is uncertain would let a later borrower acquire the key trivially while every other
    //    session blocks on it forever -- and one whose `lock_timeout` reset is uncertain is safer
    //    discarded too, rather than silently carrying a stale timeout into unrelated future queries.
    client.release(!releaseCleanly)
  }
}
