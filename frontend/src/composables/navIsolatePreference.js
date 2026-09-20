/**
 * Which click isolates a folder -- opens it and its ancestor chain, collapsing every other folder.
 * OFF: shift+click isolates and a bare left-click is the regular open/close toggle. ON swaps the
 * two.
 *
 * Browser-local rather than account-scoped: this is how clicking behaves for whoever is at this
 * screen, not a value that should follow a reader across devices.
 */

const ISOLATE_ON_LEFT_CLICK_KEY = 'wiki.nav.isolateOnLeftClick'

/** Unreadable storage (a private window, blocked site data) is treated the same as absent. */
export function isolateOnLeftClick() {
  try {
    return globalThis.localStorage?.getItem(ISOLATE_ON_LEFT_CLICK_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * A no-op if storage is full or denied: the toggle still works for this session, it just is not
 * remembered for the next one.
 */
export function setIsolateOnLeftClick(value) {
  try {
    globalThis.localStorage?.setItem(ISOLATE_ON_LEFT_CLICK_KEY, value ? 'true' : 'false')
  } catch {
    // -> Full, or storage denied.
  }
}
