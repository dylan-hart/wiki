import type { PageWatchNotifiableAction } from '../../models/pageWatchEvents.ts'

/** What `models/pages.ts#notifyWatchers` queues after resolving a page change's watcher list. */
export interface NotifyPageWatchersPayload {
  siteId: string
  pageId: string
  action: PageWatchNotifiableAction
  watcherIds: string[]
}

/**
 * Record a pending notification for each watcher of a page change.
 *
 * The watcher list itself was already resolved — and the actor excluded from it — before this was
 * queued (see `notifyWatchers`); a page cascade-deletes its watch rows, so re-resolving here would
 * find nobody left for a `deleted` event. What is left for this job, and the reason it exists rather
 * than writing these rows inline, is the part that scales with how many people watch the page: one
 * `pageWatchEvents` row per watcher. Delivering them — rendering and sending the mail — is a later
 * task; this only records that each one is owed.
 */
export async function task(payload?: NotifyPageWatchersPayload): Promise<void> {
  if (!payload || payload.watcherIds.length < 1) {
    return
  }
  const { siteId, pageId, action, watcherIds } = payload
  try {
    await WIKI.models.pageWatchEvents.recordMany(
      watcherIds.map((userId) => ({ siteId, pageId, userId, action }))
    )
  } catch (err: any) {
    WIKI.logger.error(`Recording page watch notifications for page ${pageId}: [ FAILED ]`)
    WIKI.logger.error(err.message)
    throw err
  }
}
