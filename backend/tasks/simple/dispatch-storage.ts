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
 * the event — see its doc for why that filtering happens before this ever runs.
 *
 * Runs **in-process** (`tasks/simple/`), not in a worker thread — unlike `dispatchWebhook`, this task
 * cannot get away with only the two models it imports directly. The `StorageModule` handlers it calls
 * (`modules/storage/git/*`, `disk/storage.ts`, `sftp/pages.ts`, ...) reach for a good chunk of the app
 * on their own: `WIKI.models.pages`, `.assets`, `.users`, `.tree`, `.extensions`, the `WIKI.sites`
 * site-config cache, and `WIKI.data.systemIds`. A worker thread's `WIKI` (`worker.ts`) carries none of
 * that — only `settings`, loaded lazily for the handful of workers that need it — so every one of those
 * reads was a `TypeError` waiting to happen (or, for the `WIKI.sites?.[id]` guarded reads, a silent
 * locale mis-resolution to `'en'`), invisible to `tsc` because the worker's `WIKI` is typed as the same
 * full `WikiGlobal` the main process populates. Replicating that much of boot inside a worker just to
 * keep this one task off the main thread would be a second, parallel bootstrap to keep in sync forever;
 * running it where every model it transitively needs already exists is what actually fixes it. The I/O
 * itself (a git push, an S3 `PUT`) is still async and non-blocking either way — an in-process task never
 * held up a request thread, since it is picked up by the scheduler's own polling loop, not run inline
 * with whatever queued it.
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
 * The actual handler call is wrapped in `withAdvisoryLock`, keyed by `targetId`: the scheduler claims
 * and runs several jobs concurrently (`processJob`'s `Promise.allSettled`, per `core/scheduler.ts`),
 * and a wiki normally runs more than one instance, so two dispatches for the *same* target can still
 * genuinely interleave — a write-path push racing a scheduled pull for a file-backed module such as
 * `git` is a real race on the one on-disk working copy both are about to run `git` commands against,
 * whether that interleaving happens across two `await`s in one process or across two processes
 * entirely. Locking here, once, at the single choke point every dispatch already passes through closes
 * that race for every storage module. See that helper's doc for why this is a Postgres advisory lock
 * rather than an in-process one — cross-instance is exactly the case an in-process mutex can't cover.
 *
 * `contentSync.recordSuccess`/`recordFailure` are deliberately called *after* `withLock` returns, not
 * from inside its callback (OpenProject #2252). `withAdvisoryLock` checks a connection out of the pool
 * for the whole callback's duration; a `recordSuccess`/`recordFailure` call still inside it needs a
 * *second* connection while the callback is still holding the first. On a pool already at its
 * configured `max` — several concurrent dispatches, each holding its own lock connection — that second
 * `pool.connect()` has nothing to wait on but a connection none of those calls can ever free, since
 * none of them can return without it: a deadlock, not a stall. The outcome (success, or the thrown
 * error) is still captured from inside the callback; only the db-touching call recording it moves
 * outside, so the lock connection is back in the pool before that write is even attempted.
 *
 * @param deps Real models (and lock) by default; overridable so tests can exercise the branching here
 *             without a database or a loaded module. Each has its own default rather than one default
 *             for the whole object, so a test overriding only `storage`/`contentSync` still gets the
 *             real `withAdvisoryLock` and vice versa.
 */
export async function task(
  payload: DispatchStoragePayload,
  _jobId?: string,
  deps: {
    storage?: typeof storage
    contentSync?: typeof contentSync
    withLock?: typeof withAdvisoryLock
  } = {}
): Promise<void> {
  const {
    storage: storageDep = storage,
    contentSync: contentSyncDep = contentSync,
    withLock = withAdvisoryLock
  } = deps
  const { targetId, siteId, contentType, contentId, handler, data } = payload

  const target = await storageDep.getSiteTargetById(siteId, targetId)
  if (!target) {
    // -> Deleted (or its site was) between queueing and delivery; nothing to do and nothing to retry
    WIKI.logger.debug('storage', 'target no longer exists, dispatch skipped', {
      target: targetId,
      handler
    })
    return
  }

  const mod = await storageDep.ensureModule(target.module)
  if (!mod || typeof mod[handler] !== 'function') {
    WIKI.logger.debug('storage', 'module has no such handler, dispatch skipped', {
      target: target.id,
      module: target.module,
      handler
    })
    return
  }

  let caughtErr: any = null
  try {
    await withLock(`storage-target:${targetId}`, () => mod[handler](target, data))
  } catch (err: any) {
    caughtErr = err
  }

  if (caughtErr) {
    if (contentType && contentId) {
      await contentSyncDep.recordFailure({
        contentType,
        contentId,
        targetId,
        error: caughtErr.message
      })
    }
    WIKI.logger.warn('storage', 'dispatch failed', {
      target: target.id,
      module: target.module,
      handler,
      error: caughtErr
    })
    // -> Rethrown so the job fails and the scheduler retries with its usual backoff
    throw caughtErr
  }

  if (contentType && contentId) {
    await contentSyncDep.recordSuccess({ contentType, contentId, targetId, direction: 'push' })
  }
}
