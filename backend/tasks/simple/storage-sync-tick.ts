import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const queued = await CARDINAL.models.storage.tickScheduledSyncs()
  // -> No summary when idle: a tick that queued nothing stays off the `info` log.
  if (queued > 0) {
    return { summary: 'queued scheduled syncs', queued }
  }
}
