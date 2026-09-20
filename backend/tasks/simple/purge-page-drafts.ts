import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Backstop for a page abandoned mid-edit and never reopened: every other draft is already cleared on
 * save by `core/collab.ts#pageSaved()`.
 */
export async function task(): Promise<TaskResult | void> {
  const purged = await CARDINAL.models.pageDrafts.purgeStale()
  if (purged > 0) {
    return { summary: 'purged stale autosave drafts', purged }
  }
}
