import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const queued = await WIKI.models.storage.tickScheduledSyncs()
  // -> Runs on a short interval and finds nothing almost every time, so the idle case says nothing at
  //    all and the scheduler's own `debug jobs storageSyncTick finished` is the whole record of it
  //    (audit X1/X2). Only a tick that actually queued work is worth an operator's `info` log.
  if (queued > 0) {
    return { summary: 'queued scheduled syncs', queued }
  }
}
