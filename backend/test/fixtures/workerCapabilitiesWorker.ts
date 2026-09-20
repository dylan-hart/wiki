import { workerData } from 'node:worker_threads'

/**
 * `worker.ts` cannot be imported by a test — it boots a minimal `CARDINAL`, reads config off disk
 * and builds its handler at import time — so this repeats the one read it uses to settle
 * `CARDINAL.capabilities`, in a real thread. It proves the half a source scan cannot: that piscina's
 * `workerData` really does carry `capabilities` into the thread's `node:worker_threads` module.
 */
const capabilities = (workerData as { capabilities?: unknown } | null)?.capabilities

export default async () => capabilities
