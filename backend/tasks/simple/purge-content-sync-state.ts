import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Backstop for `contentSyncState` rows whose `contentId` matches no `pages`/`assets` row: the
 * delete path's own cleanup cannot reach one lost to a failed dispatch.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.contentSync.purgeOrphaned()
  if (count > 0) {
    return { summary: 'purged orphaned contentSyncState rows', purged: count }
  }
}
