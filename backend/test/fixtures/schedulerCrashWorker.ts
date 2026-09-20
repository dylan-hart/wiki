/**
 * A real piscina worker, so `executeOnWorker`'s two failure paths are exercised against an actual
 * thread rather than a mock:
 *
 * - the default never resolves, so only `AbortSignal.timeout` can end it — the "merely slow" ceiling.
 * - `mode: 'crash'` calls `process.exit()`, which Node scopes to the calling worker thread alone.
 *   Threads share one OS process and cannot be SIGKILLed independently, but this produces the
 *   identical externally-observable failure: the thread is gone and nothing answers.
 */
export default async (job: any) => {
  // -> `executeOnWorker` hands `run()` the whole job (`{ task, payload }`), so the mode arrives
  //    under `job.payload`, not on `job` itself.
  if (job?.payload?.mode === 'crash') {
    process.exit(1)
  }
  await new Promise(() => {})
}
