import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Sweep `contentSyncState` rows whose `contentId` no longer matches any `pages`/`assets` row
 * (OpenProject #1679) -- the backstop for rows the delete-path's own cleanup cannot reach because
 * they predate it or were lost to a failed dispatch. Mirrors `purge-pageviews.ts`'s shape: a single
 * model call, and a summary handed back only when it actually removed something.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await WIKI.models.contentSync.purgeOrphaned()
  if (count > 0) {
    return { summary: 'purged orphaned contentSyncState rows', purged: count }
  }
}
