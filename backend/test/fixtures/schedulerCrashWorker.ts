import { ThreadWorker } from 'poolifier'

/**
 * Fixture for `core/scheduler.test.ts`'s `executeOnWorker` suite (task 704) — a real poolifier worker
 * built to exercise `executeOnWorker`'s two timeout ceilings against an actual worker thread, not a
 * mock of one:
 *
 * - `mode: 'hang'` never resolves on its own, so only `AbortSignal.timeout` (poolifier's own abort
 *   handling, passed through from `executeOnWorker`) can end it — the "task is merely slow" ceiling.
 * - `mode: 'crash'` calls `process.exit()`. Node scopes that to the calling worker thread alone — it
 *   ends this worker without touching the host process, the same way an OOM kill or a native crash
 *   would (this is the practical equivalent of `kill -9` against a worker thread: individual threads
 *   share one OS process and cannot be SIGKILLed independently, but `process.exit()` inside one
 *   produces the identical externally-observable failure — the thread is gone, nothing answers).
 *   Poolifier has nothing left to abort or reject at that point, which is exactly why
 *   `executeOnWorker` carries its own backup timer — the "nothing is coming back" ceiling.
 */
export default new ThreadWorker(async (job: any) => {
  // -> The data `executeOnWorker` hands `workerPool.execute()` is the job shape itself
  //    (`{ task, payload }`), so the mode this fixture switches on lives under `job.payload`, not on
  //    `job` directly.
  if (job?.payload?.mode === 'crash') {
    process.exit(1)
  }
  await new Promise(() => {})
})
