/**
 * The `/actions/:action` handlers `api/storage.ts` queues on the scheduler rather than running inline
 * -- mirrors `SYNC_SHAPED_ACTIONS` in `backend/models/storage.ts`. Duplicated rather than imported:
 * `frontend/` and `backend/` are separate workspaces with no shared source.
 */
export const SYNC_SHAPED_ACTIONS = ['sync', 'syncUntracked', 'importAll']

export function isQueuedAction(handler) {
  return SYNC_SHAPED_ACTIONS.includes(handler)
}

/**
 * Mirrors what `validateTarget` in `backend/models/storage.ts` refuses outright: a `mode` patch for a
 * module with only one supported mode, and a `scheduleOverride` patch for a module with no schedule
 * at all (`sync.schedule === false`). Unlike e.g. `assetDelivery.streaming`, which the backend
 * re-derives and ignores, a disallowed `sync` field fails validation for the entire batched PUT,
 * taking every other target's changes down with it -- so the field has to be omitted here, not
 * merely greyed out in the UI.
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
 * Derived from the raw summary `GET .../sync-status` returns (`TargetSyncSummary` in
 * `backend/models/contentSync.ts`). Priority order: a fresh error always wins, even over a target
 * that has synced successfully before -- that failure is the thing worth an operator's attention.
 * "never" only once nothing has EVER succeeded; "outOfDate" only once there is a successful sync to
 * have gone stale since.
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
