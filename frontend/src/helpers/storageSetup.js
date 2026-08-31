/**
 * The `step` name to send a storage target's next setup POST with (task 1895, WP 1895).
 *
 * `POST /sites/:siteId/storage/targets/:targetId/setup` takes a `step` the module names — there is
 * no fixed vocabulary, since only the module implementing `mod.setup()` knows what it is currently
 * waiting on. What IS fixed is the one name every module agrees on for the very first call:
 * `'start'`, sent when the target has never begun setup (`state === 'notconfigured'`, the value every
 * target with a `setup` block is created with — see `models/storage.ts`'s `getSiteTargets`). Past
 * that first call, the module's own returned state (persisted back onto `target.setup.state`) IS the
 * name of the step to run next, so re-sending it verbatim is what lets one button both start and
 * advance the process without this page needing to track a separate "what step are we on" value of
 * its own.
 *
 * A target already `'configured'` has nothing left to advance — callers gate the button on that
 * state themselves (`AdminStorage.vue`'s "Start/Continue Setup" row only renders while it isn't), so
 * this is never asked to name a step for one; it answers `null` rather than guessing.
 *
 * @param {string | null | undefined} setupState `target.setup.state` as the API last reported it
 * @returns {string | null} The `step` to send next, or `null` for an already-configured target
 */
export function nextSetupStepName(setupState) {
  if (setupState === 'configured') {
    return null
  }
  if (!setupState || setupState === 'notconfigured') {
    return 'start'
  }
  return setupState
}
