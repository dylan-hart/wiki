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
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pool = WIKI.db.$client as Pool
  const client = await pool.connect()
  // -> Set when the unlock query itself fails, so the outer `finally` knows the connection's lock
  //    state is uncertain and must discard it rather than return it to the pool.
  let unlockFailed = false
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
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
        WIKI.logger.warn(
          `withAdvisoryLock: failed to release advisory lock for key '${key}', discarding connection: ${err.message}`
        )
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
