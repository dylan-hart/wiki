import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Fences `CARDINAL.models.jobs.setResult()` against a timed-out in-process task clobbering a later
 * retry's result. `core/scheduler.ts#executeInProcess()` cannot cancel an in-process task once its
 * `taskTimeout` trips -- there is no thread to tear down -- so the abandoned promise keeps running
 * and may still call `setResult(jobId, ...)` after the id has been reclaimed by a retry.
 *
 * Carried through `AsyncLocalStorage` rather than a `SimpleTask` parameter: no task has to declare
 * or forward one, and that argument position is already `deps` in `tasks/simple/import-content.ts`
 * and `tasks/simple/dispatch-storage.ts`. ALS follows a promise's continuations however late they
 * settle, so a stale one keeps the attempt number it was launched under.
 */
export interface JobExecutionContext {
  jobId: string
  /** `job.retries + 1`, as the claim recorded it in `jobHistory.attempt`. */
  attempt: number
}

const jobExecutionContextStorage = new AsyncLocalStorage<JobExecutionContext>()

export function runWithJobExecutionContext<T>(context: JobExecutionContext, fn: () => T): T {
  return jobExecutionContextStorage.run(context, fn)
}

export function getJobExecutionContext(): JobExecutionContext | undefined {
  return jobExecutionContextStorage.getStore()
}
