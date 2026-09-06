import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const queued = await WIKI.models.replication.tick()
  // -> Same shape as `storage-sync-tick.ts`: idle is the common case, every few minutes, and the
  //    scheduler's own `debug` finish line already records that the tick ran.
  if (queued > 0) {
    return { summary: 'queued replication pulls', queued }
  }
}
