import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Fences `WIKI.models.jobs.setResult()` against a stale, previously-timed-out in-process task
 * clobbering a later, legitimately-completed retry's result (OpenProject #2351).
 *
 * `core/scheduler.ts#executeInProcess()` cannot actually cancel an in-process task once its
 * `taskTimeout` ceiling trips -- there is no thread to tear down, so the task's own promise keeps
 * running (and, eventually, settling) in the background. If that stale task calls
 * `setResult(jobId, ...)` after the ceiling, and the same job id has since been reclaimed and
 * completed by a later retry, an unconditional write would overwrite the retry's result with the
 * abandoned one.
 *
 * Threading an `attempt`/generation number through `SimpleTask`'s own call signature would need
 * every task to declare and forward a parameter it otherwise has no use for, and collides with
 * `tasks/simple/import-content.ts` and `tasks/simple/dispatch-storage.ts`, which already use that
 * position for their own `deps` parameter. Carrying it via `AsyncLocalStorage` instead needs no
 * task to change at all: `runWithJobExecutionContext()` wraps a task's invocation once, in
 * `executeInProcess()`, and `getJobExecutionContext()` reads it back from wherever `setResult()`
 * happens to be called -- however deep in that task's own await chain, however late it settles.
 * Node's ALS context follows a promise's continuations regardless of how long they run, which is
 * exactly what makes a *stale* continuation (one still running after `Promise.race` has already
 * rejected on the timeout) keep seeing the attempt number it was actually launched under, not
 * whatever the job's `jobHistory` row has since been bumped to by a reclaim.
 */
export interface JobExecutionContext {
  /** The `jobHistory`/`jobs` row id this task run belongs to. */
  jobId: string
  /** The attempt number (`job.retries + 1`) this specific claim recorded in `jobHistory.attempt`. */
  attempt: number
}

const jobExecutionContextStorage = new AsyncLocalStorage<JobExecutionContext>()

/** Run `fn` with `context` available to `getJobExecutionContext()` throughout its async chain. */
export function runWithJobExecutionContext<T>(context: JobExecutionContext, fn: () => T): T {
  return jobExecutionContextStorage.run(context, fn)
}

/** The job execution context of the nearest enclosing `runWithJobExecutionContext()` call, if any. */
export function getJobExecutionContext(): JobExecutionContext | undefined {
  return jobExecutionContextStorage.getStore()
}
