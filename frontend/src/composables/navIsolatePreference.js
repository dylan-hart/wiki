/**
 * Whether a bare left-click on a folder isolates it -- opens it and its ancestor chain, and
 * collapses every other folder in the tree -- instead of the regular open/close toggle (OpenProject
 * #3057/#3062). OFF by default: with the toggle off, SHIFT+click isolates and a bare left-click keeps
 * the regular toggle; ON swaps the two, so a bare left-click isolates and shift+click falls back to
 * the regular toggle. See `NavSidebarItem.vue`'s own click-handling doc comments for the isolate/
 * cycle logic this preference feeds into.
 *
 * Browser-local, not account-scoped -- the same convention `FileManager.vue`'s own
 * `VIEW_OPTIONS_KEY` view options use: this is "how clicking in a tree behaves for whoever is at
 * this screen" rather than a value that should follow a reader across devices. Kept in its own
 * module, distinct from `navExpansionState.js`'s session-only open/closed state, so a second
 * consumer -- the epic's deferred File Manager tree equivalent (OpenProject #3063) -- can read the
 * same preference later without re-deriving the storage key or its shape. No settings UI reads or
 * writes this yet; today's only caller is `NavSidebarItem.vue`'s click handling.
 */

const ISOLATE_ON_LEFT_CLICK_KEY = 'wiki.nav.isolateOnLeftClick'

/**
 * Whether the toggle is currently ON. Defaults to OFF (`false`) whenever nothing has been stored
 * yet, or storage is unreadable (a private window, cleared or blocked site data) -- unreadable is
 * treated the same as absent, matching `FileManager.vue#storedViewOptions()`'s own convention.
 */
export function isolateOnLeftClick() {
  try {
    return globalThis.localStorage?.getItem(ISOLATE_ON_LEFT_CLICK_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Persists the toggle's new value. Silently a no-op if storage is full or denied -- the toggle
 * still works for the rest of this session, it just will not be remembered for the next one.
 */
export function setIsolateOnLeftClick(value) {
  try {
    globalThis.localStorage?.setItem(ISOLATE_ON_LEFT_CLICK_KEY, value ? 'true' : 'false')
  } catch {
    // -> Full, or storage denied.
  }
}
