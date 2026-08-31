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
 * Acquisition is bounded by `LOCK_TIMEOUT_MS`: `pg_advisory_lock` takes Postgres's regular lock
 * manager path, so the session `lock_timeout` GUC applies to it exactly as it would to a row or
 * table lock. Without it, a contended key blocks the calling connection — and the scheduler slot
 * running it — forever; the only caller (`tasks/simple/dispatch-storage.ts`) runs in-process, so an
 * unbounded wait here is the unbounded wait behind a worker-slot leak, not merely a slow job. A
 * caller that cannot acquire within the bound gets a rejected promise naming the key, so the job is
 * recorded failed and retried on the scheduler's normal backoff instead of hanging.
 *
 * `lock_timeout` is set with `set_config(..., false)` (session-level) rather than `SET LOCAL`:
 * `SET LOCAL` only takes effect inside a transaction block — outside one it is a silent no-op (with
 * a warning), and this helper deliberately does not wrap the lock query in a transaction. The
 * setting is reset to `0` (disabled) immediately after the acquisition attempt, before `fn()` runs
 * and before the client goes back to the pool — a session-level GUC would otherwise leak onto
 * whatever unrelated query the pool hands this same connection to next.
 */
const LOCK_TIMEOUT_MS = 10_000

export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pool = WIKI.db.$client as Pool
  const client = await pool.connect()
  try {
    await client.query('SELECT set_config($1, $2, false)', [
      'lock_timeout',
      String(LOCK_TIMEOUT_MS)
    ])
    try {
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
      } catch (err: any) {
        throw new Error(
          `Timed out acquiring advisory lock for key "${key}" after ${LOCK_TIMEOUT_MS}ms`,
          { cause: err }
        )
      }
    } finally {
      // -> Runs whether the acquisition succeeded or timed out, so the raised lock_timeout never
      //    outlives this one query on a connection that is about to be reused for something else.
      await client.query('SELECT set_config($1, $2, false)', ['lock_timeout', '0'])
    }
    try {
      return await fn()
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
    }
  } finally {
    client.release()
  }
}
