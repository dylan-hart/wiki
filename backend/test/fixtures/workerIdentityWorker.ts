import { threadId, workerData } from 'node:worker_threads'
import { workerInstanceId } from '../../helpers/bootSummary.ts'

/**
 * `worker.ts` cannot be imported by a test — it boots a minimal `CARDINAL`, reads config off disk
 * and builds its handler at import time — so this repeats the three lines it uses to settle its
 * `INSTANCE_ID`, in a real thread: proof that piscina's `workerData` really does reach the thread's
 * `node:worker_threads` module. The read is at module scope, as `worker.ts` does it, so a
 * regression that only settles the id once a job arrives still shows up here.
 */
const INSTANCE_ID = workerInstanceId(
  (workerData as { parentInstanceId?: unknown } | null)?.parentInstanceId,
  threadId
)

export default async () => INSTANCE_ID
