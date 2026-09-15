import { ThreadWorker } from 'poolifier'
import { workerData } from 'node:worker_threads'

/**
 * Fixture for `core/schedulerWorkerCapabilities.test.ts` (OpenProject #3124).
 *
 * `worker.ts` itself cannot be imported by a test — it boots a whole minimal `CARDINAL`, reads config
 * off disk and constructs a `ThreadWorker` at import time — so this is the same one-line read it
 * uses to settle `CARDINAL.capabilities`, run in a real thread. What it proves is the half a pure source
 * scan cannot: that poolifier's `workerOptions.workerData` actually carries a `capabilities` object
 * into the worker thread's `node:worker_threads` module, the transport `core/scheduler.ts`'s
 * `poolOptions` now uses for it (mirroring `test/fixtures/workerIdentityWorker.ts`'s proof for
 * `parentInstanceId`).
 */
const capabilities = (workerData as { capabilities?: unknown } | null)?.capabilities

export default new ThreadWorker(async () => capabilities)
