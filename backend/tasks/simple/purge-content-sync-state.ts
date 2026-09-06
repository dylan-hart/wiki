/**
 * Sweep `contentSyncState` rows whose `contentId` no longer matches any `pages`/`assets` row
 * (OpenProject #1679) -- the backstop for rows the delete-path's own cleanup cannot reach because
 * they predate it or were lost to a failed dispatch. Mirrors `purge-pageviews.ts`'s shape: a single
 * model call, logged only when it actually removed something.
 */
export async function task(): Promise<void> {
  const count = await WIKI.models.contentSync.purgeOrphaned()
  if (count > 0) {
    WIKI.logger.info('storage', 'purged orphaned contentSyncState rows', { purged: count })
  }
}
