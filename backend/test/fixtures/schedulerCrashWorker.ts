/**
 * Fixture for `core/scheduler.execution.test.ts`'s `executeOnWorker` suite (task 704) — a real
 * piscina worker built to exercise `executeOnWorker`'s two failure paths against an actual worker
 * thread, not a mock of one:
 *
 * - `mode: 'hang'` never resolves on its own, so only `AbortSignal.timeout` (piscina's own abort
 *   handling, passed through from `executeOnWorker` as `run()`'s `signal` option) can end it — the
 *   "task is merely slow" ceiling.
 * - `mode: 'crash'` calls `process.exit()`. Node scopes that to the calling worker thread alone — it
 *   ends this worker without touching the host process, the same way an OOM kill or a native crash
 *   would (this is the practical equivalent of `kill -9` against a worker thread: individual threads
 *   share one OS process and cannot be SIGKILLed independently, but `process.exit()` inside one
 *   produces the identical externally-observable failure — the thread is gone, nothing answers).
 *   Unlike poolifier, piscina rejects the in-flight `run()` promise itself the moment it sees the
 *   worker exit (its pool's own `onWorkerExit` handler) — see `executeOnWorker`'s doc comment for why
 *   the backup timer still exists on top of that.
 */
export default async (job: any) => {
  // -> The data `executeOnWorker` hands `workerPool.run()` is the job shape itself
  //    (`{ task, payload }`), so the mode this fixture switches on lives under `job.payload`, not on
  //    `job` directly.
  if (job?.payload?.mode === 'crash') {
    process.exit(1)
  }
  await new Promise(() => {})
}
