import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Sweep autosaved `pageDrafts` rows nothing has touched in `STALE_DRAFT_DAYS` -- a page abandoned
 * mid-edit and never reopened (OpenProject #2454). Everything else is already cleared on save by
 * `core/collab.ts#pageSaved()`; this is only the backstop for what that path never sees. Mirrors
 * `purge-rate-limits.ts`'s shape: a single model call, and a summary handed back only when it
 * actually removed something.
 */
export async function task(): Promise<TaskResult | void> {
  const purged = await WIKI.models.pageDrafts.purgeStale()
  if (purged > 0) {
    return { summary: 'purged stale autosave drafts', purged }
  }
}
