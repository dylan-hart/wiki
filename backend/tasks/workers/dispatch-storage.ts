import { storage } from '../../models/storage.ts'
import { contentSync } from '../../models/contentSync.ts'
import type { SyncContentType } from '../../models/contentSync.ts'

export interface DispatchStoragePayload {
  targetId: string
  siteId: string
  contentType: SyncContentType
  /** The page's or asset's own id, i.e. `contentSyncState.contentId`. */
  contentId: string
  /** The `StorageModule` handler to call, e.g. `created` or `assetUploaded` — see `models/storage.ts`. */
  handler: string
  /** The same object `models/pages.ts` / `models/assets.ts` passed to `storage.dispatch()`. */
  data: Record<string, any>
}

/**
 * Deliver one write-path event to one storage target.
 *
 * Queued by `models/storage.ts` → `dispatch()`, one job per enabled target whose content types cover
 * the event — see its doc for why that filtering happens before this ever runs. Runs in a worker
 * thread rather than in-process for the same reason `dispatchWebhook` does: a target write is I/O this
 * codebase does not control the latency of (a git push, an S3 `PUT`), and a busy wiki must not have
 * page saves waiting on it.
 *
 * The models this needs are imported directly rather than taken off `WIKI.models`, which a worker
 * thread does not carry (see `worker.ts`) — the same convention `dispatch-webhook.ts` follows.
 *
 * Never throws for a target that cannot be reached at all — a deleted target or a module with no
 * implementation is not something retrying will fix, so it is logged and skipped, matching
 * `ensureModule()`'s own "missing means null, not an error" handling. It *does* throw once delivery
 * was actually attempted and failed, so the scheduler retries with its usual backoff — same as
 * `dispatchWebhook`.
 *
 * @param deps Real models by default; overridable so tests can exercise the branching here without a
 *             database or a loaded module.
 */
export async function task(
  job: { payload: DispatchStoragePayload },
  deps: { storage: typeof storage; contentSync: typeof contentSync } = { storage, contentSync }
): Promise<void> {
  await WIKI.ensureDb!()
  const { targetId, siteId, contentType, contentId, handler, data } = job.payload

  const target = await deps.storage.getSiteTargetById(siteId, targetId)
  if (!target) {
    // -> Deleted (or its site was) between queueing and delivery; nothing to do and nothing to retry
    WIKI.logger.info(`Storage target ${targetId} no longer exists, skipping "${handler}" dispatch.`)
    return
  }

  const mod = await deps.storage.ensureModule(target.module)
  if (!mod || typeof mod[handler] !== 'function') {
    WIKI.logger.debug(
      `${target.title} storage module has no "${handler}" handler installed, skipping dispatch.`
    )
    return
  }

  try {
    await mod[handler](target, data)
    await deps.contentSync.recordSuccess({ contentType, contentId, targetId, direction: 'push' })
  } catch (err: any) {
    await deps.contentSync.recordFailure({ contentType, contentId, targetId, error: err.message })
    WIKI.logger.warn(
      `Failed to dispatch "${handler}" to storage target ${target.title}: ${err.message}`
    )
    // -> Rethrown so the job fails and the scheduler retries with its usual backoff
    throw err
  }
}
