import { storage } from '../../models/storage.ts'
import { contentSync } from '../../models/contentSync.ts'
import { withAdvisoryLock } from '../../helpers/advisoryLock.ts'
import type { SyncContentType } from '../../models/contentSync.ts'

export interface DispatchStoragePayload {
  targetId: string
  siteId: string
  /**
   * Present for a write-path content event; absent for a `storageSyncTick`-queued target-level sync
   * (`handler: 'sync'`), which has no single content item to record state against — `models/storage.ts`
   * `tickScheduledSyncs()` tracks its own progress on the `storage` row's `lastTickAt` instead.
   */
  contentType?: SyncContentType
  /** The page's or asset's own id, i.e. `contentSyncState.contentId` — see `contentType` above. */
  contentId?: string
  /**
   * The `StorageModule` handler to call — a content handler such as `created`/`assetUploaded` (see
   * `models/storage.ts`), or a whole-target action such as `sync`/`syncUntracked`/`importAll` queued
   * by `storageSyncTick` or the `/actions/:action` route (see `SYNC_SHAPED_ACTIONS`).
   */
  handler: string
  /**
   * The same object `models/pages.ts` / `models/assets.ts` passed to `storage.dispatch()`, or `{}` for
   * a whole-target action, which has no single content item's data to carry.
   */
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
 * `contentSync` is only ever updated for a content-level payload (`contentType`/`contentId` both set).
 * A whole-target action such as `sync` has no single content item to record state against, so that
 * step is skipped for it — see `DispatchStoragePayload`.
 *
 * The actual handler call is wrapped in `withAdvisoryLock`, keyed by `targetId`: this task runs in a
 * worker-thread pool (`scheduler.workers`, 3 by default), so two dispatches for the *same* target can
 * otherwise execute concurrently on separate threads with no shared JS memory to serialize them — a
 * write-path push racing a scheduled pull for a file-backed module such as `git` is a real race on the
 * one on-disk working copy both are about to run `git` commands against. See that helper's doc for why
 * this is a Postgres advisory lock rather than an in-process one.
 *
 * @param deps Real models (and lock) by default; overridable so tests can exercise the branching here
 *             without a database or a loaded module. Each has its own default rather than one default
 *             for the whole object, so a test overriding only `storage`/`contentSync` still gets the
 *             real `withAdvisoryLock` and vice versa.
 */
export async function task(
  job: { payload: DispatchStoragePayload },
  deps: {
    storage?: typeof storage
    contentSync?: typeof contentSync
    withLock?: typeof withAdvisoryLock
  } = {}
): Promise<void> {
  await WIKI.ensureDb!()
  const {
    storage: storageDep = storage,
    contentSync: contentSyncDep = contentSync,
    withLock = withAdvisoryLock
  } = deps
  const { targetId, siteId, contentType, contentId, handler, data } = job.payload

  const target = await storageDep.getSiteTargetById(siteId, targetId)
  if (!target) {
    // -> Deleted (or its site was) between queueing and delivery; nothing to do and nothing to retry
    WIKI.logger.info(`Storage target ${targetId} no longer exists, skipping "${handler}" dispatch.`)
    return
  }

  const mod = await storageDep.ensureModule(target.module)
  if (!mod || typeof mod[handler] !== 'function') {
    WIKI.logger.debug(
      `${target.title} storage module has no "${handler}" handler installed, skipping dispatch.`
    )
    return
  }

  await withLock(`storage-target:${targetId}`, async () => {
    try {
      await mod[handler](target, data)
      if (contentType && contentId) {
        await contentSyncDep.recordSuccess({ contentType, contentId, targetId, direction: 'push' })
      }
    } catch (err: any) {
      if (contentType && contentId) {
        await contentSyncDep.recordFailure({ contentType, contentId, targetId, error: err.message })
      }
      WIKI.logger.warn(
        `Failed to dispatch "${handler}" to storage target ${target.title}: ${err.message}`
      )
      // -> Rethrown so the job fails and the scheduler retries with its usual backoff
      throw err
    }
  })
}
