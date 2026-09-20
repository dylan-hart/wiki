import { storage } from '../../models/storage.ts'
import { contentSync } from '../../models/contentSync.ts'
import { withAdvisoryLock } from '../../helpers/advisoryLock.ts'
import type { SyncContentType } from '../../models/contentSync.ts'

export interface DispatchStoragePayload {
  targetId: string
  siteId: string
  /**
   * Set for a write-path content event, absent for a target-level sync, which has no single content
   * item to record sync state against.
   */
  contentType?: SyncContentType
  contentId?: string
  /**
   * The `StorageModule` handler to call: a content handler such as `created`/`assetUploaded`, or a
   * whole-target action such as `sync`/`syncUntracked`/`importAll`.
   */
  handler: string
  /** Whatever was passed to `storage.dispatch()`, or `{}` for a whole-target action. */
  data: Record<string, any>
}

/**
 * Runs **in-process** (`tasks/simple/`), not in a worker thread: the `StorageModule` handlers it calls
 * reach for `CARDINAL.models.pages`/`.assets`/`.users`/`.tree`/`.extensions`, the `CARDINAL.sites` cache
 * and `CARDINAL.data.systemIds`, none of which `worker.ts`'s minimal `CARDINAL` carries — and `tsc` cannot
 * see the difference, because a worker's `CARDINAL` is typed as the same full `CardinalGlobal`. The I/O
 * (a git push, an S3 `PUT`) is async either way, and the scheduler's polling loop runs this, not the
 * request that queued it.
 *
 * A target that cannot be reached at all — deleted, or a module with no implementation — is logged and
 * skipped rather than thrown: retrying will not fix it. A delivery that was attempted and failed does
 * throw, so the scheduler retries with its usual backoff.
 *
 * The handler call is wrapped in `withAdvisoryLock` keyed by `targetId`: the scheduler runs several
 * claimed jobs concurrently and a wiki normally runs more than one instance, so a write-path push and
 * a scheduled pull for the same file-backed target (`git`) can race on the one on-disk working copy
 * both run commands against. This single choke point closes that race for every storage module, and
 * the lock is a Postgres advisory lock because the race crosses processes.
 *
 * `contentSync.recordSuccess`/`recordFailure` must stay *outside* `withLock`'s callback:
 * `withAdvisoryLock` holds a pool connection for the callback's whole duration, so a db call made
 * inside it needs a second one. With the pool at its configured `max` — several concurrent dispatches
 * each holding a lock connection — that second `pool.connect()` waits on a connection none of them can
 * free until they return, which is a deadlock rather than a stall.
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
    CARDINAL.logger.debug('storage', 'target no longer exists, dispatch skipped', {
      target: targetId,
      handler
    })
    return
  }

  const mod = await storageDep.ensureModule(target.module)
  if (!mod || typeof mod[handler] !== 'function') {
    CARDINAL.logger.debug('storage', 'module has no such handler, dispatch skipped', {
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
    CARDINAL.logger.warn('storage', 'dispatch failed', {
      target: target.id,
      module: target.module,
      handler,
      error: caughtErr
    })
    throw caughtErr
  }

  if (contentType && contentId) {
    await contentSyncDep.recordSuccess({ contentType, contentId, targetId, direction: 'push' })
  }
}
