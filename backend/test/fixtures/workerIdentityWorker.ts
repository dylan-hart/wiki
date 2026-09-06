import { ThreadWorker } from 'poolifier'
import { threadId, workerData } from 'node:worker_threads'
import { workerInstanceId } from '../../helpers/bootSummary.ts'

/**
 * Fixture for `core/scheduler.test.ts`'s worker-identity suite (OpenProject #2671).
 *
 * `worker.ts` itself cannot be imported by a test — it boots a whole minimal `WIKI`, reads config
 * off disk and constructs a `ThreadWorker` at import time — so this is the same three lines it uses
 * to settle its `INSTANCE_ID`, run in a real thread. What it proves is the half
 * `helpers/bootSummary.test.ts` cannot: that poolifier's `workerOptions.workerData` actually reaches
 * the worker thread's `node:worker_threads` module, which is the transport the parent instance id
 * travels on.
 *
 * It answers with its own derived id and reads the id at module scope, exactly as `worker.ts` does,
 * so a regression that only settles the id once a job arrives would still show up here.
 */
const INSTANCE_ID = workerInstanceId(
  (workerData as { parentInstanceId?: unknown } | null)?.parentInstanceId,
  threadId
)

export default new ThreadWorker(async () => INSTANCE_ID)
