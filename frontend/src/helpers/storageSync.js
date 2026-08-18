/**
 * Pure logic for the storage admin page's Synchronization section (`pages/AdminStorage.vue`), pulled
 * out into its own module so it can be unit tested without mounting the whole page -- the same reason
 * `helpers/datetime.js` exists on its own.
 */

/**
 * The `/actions/:action` handlers `api/storage.ts` queues on the scheduler rather than running inline
 * -- mirrors `SYNC_SHAPED_ACTIONS` in `backend/models/storage.ts`. Duplicated rather than imported:
 * `frontend/` and `backend/` are separate workspaces with no shared source, the same reason the
 * Content Types checkboxes above already duplicate `CONTENT_TYPES` as literal `val`s.
 */
export const SYNC_SHAPED_ACTIONS = ['sync', 'syncUntracked', 'importAll']

/** Whether running this action now queues a background job rather than blocking the request. */
export function isQueuedAction(handler) {
  return SYNC_SHAPED_ACTIONS.includes(handler)
}

/**
 * The `sync` group of a target update payload, or `undefined` when there is nothing to send.
 *
 * Mirrors what `validateTarget` in `backend/models/storage.ts` refuses outright: a `mode` patch for a
 * module with only one supported mode, and a `scheduleOverride` patch for a module with no schedule at
 * all (`sync.schedule === false`). Neither gets silently ignored the way e.g. `assetDelivery.streaming`
 * is -- the backend re-derives that one from the module's capabilities, but a disallowed `sync` field
 * fails validation for the entire batched PUT, taking every other target's changes down with it. So
 * this has to matter, not just cosmetically grey out a control.
 */
export function syncPayloadFor(tgt) {
  if (!tgt?.sync) {
    return undefined
  }
  const payload = {}
  if (tgt.sync.supportedModes?.length > 1) {
    payload.mode = tgt.sync.mode
  }
  if (tgt.sync.schedule !== false) {
    // -> `||`, not `??`: an input cleared back to an empty string means "use the module default"
    //    just as much as an unset `null` does, and `ISO_DURATION_PATTERN` would otherwise refuse "".
    payload.scheduleOverride = tgt.sync.scheduleOverride || null
  }
  return Object.keys(payload).length > 0 ? payload : undefined
}

/**
 * Which of four states a target's Synchronization status card is in, derived from the raw summary
 * `GET .../sync-status` returns (see `TargetSyncSummary` in `backend/models/contentSync.ts`).
 *
 * Priority order: a fresh error always wins, even over a target that has synced successfully before --
 * that failure is the thing worth an operator's attention. "never" only once nothing has EVER
 * succeeded. "outOfDate" only once there's at least one successful sync to have gone stale since.
 */
export function syncStatusKind(summary) {
  // -> `summary` is `state.syncStatus` in the component, which starts and stays `null` (not merely
  //    `undefined`) until the fetch resolves -- a default parameter alone would not catch that.
  const { lastSyncedAt, lastError, outOfDateCount } = summary ?? {}
  if (lastError) {
    return 'error'
  }
  if (!lastSyncedAt) {
    return 'never'
  }
  if (outOfDateCount > 0) {
    return 'outOfDate'
  }
  return 'synced'
}
