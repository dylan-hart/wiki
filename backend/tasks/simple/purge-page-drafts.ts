/**
 * Sweep autosaved `pageDrafts` rows nothing has touched in `STALE_DRAFT_DAYS` -- a page abandoned
 * mid-edit and never reopened (OpenProject #2454). Everything else is already cleared on save by
 * `core/collab.ts#pageSaved()`; this is only the backstop for what that path never sees. Mirrors
 * `purge-rate-limits.ts`'s shape: a single model call, logged either way.
 */
export async function task(): Promise<void> {
  WIKI.logger.info('Purging stale autosave drafts...')

  try {
    const purged = await WIKI.models.pageDrafts.purgeStale()

    WIKI.logger.info(`Purged ${purged} stale autosave draft(s): [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error('Purging stale autosave drafts: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
