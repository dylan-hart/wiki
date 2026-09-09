import { inject, provide, reactive } from 'vue'

/**
 * Shared, tree-wide open/closed state for the navbar's folder rows (OpenProject #2846): a single
 * reactive `Map`, keyed by nav item id, provided once at `NavSidebar.vue`'s root and injected by
 * every recursive `NavSidebarItem.vue` instance -- so a folder's expanded/collapsed state survives
 * that one item's own unmount/remount (a tree re-render, a sibling task's future expand-all/
 * collapse-all/isolate action reaching an item that isn't currently mounted) rather than living on
 * the component instance the way `WExpansionItem`'s own uncontrolled `default-opened` state does.
 *
 * Session-only: nothing here is persisted past a page load, and there is no cross-tab or
 * cross-request sharing -- it is a plain in-memory `Map` for the lifetime of the mounted tree.
 */
const NAV_EXPANSION_STATE_KEY = Symbol('navExpansionState')

/**
 * Creates the shared state and provides it to descendants. Call once, from the tree's root
 * component (`NavSidebar.vue`).
 */
export function useProvideNavExpansionState() {
  const state = reactive(new Map())
  provide(NAV_EXPANSION_STATE_KEY, state)
  return state
}

/**
 * Injects the shared state and returns the read/write pair `NavSidebarItem.vue` binds its
 * `w-expansion-item` to. Falls back to a fresh, per-call `Map` when no provider is present in the
 * component tree (a unit test mounting `NavSidebarItem` standalone, without `NavSidebar` above it)
 * rather than throwing -- such a mount still needs a working, if unshared, open/closed state.
 */
export function useNavExpansionState() {
  const state = inject(NAV_EXPANSION_STATE_KEY, null) ?? reactive(new Map())

  /**
   * The open/closed value for one item: whatever was last written for it, or `defaultValue` when
   * this id has never been written. A pure read -- it never populates the map itself, so a
   * `defaultValue` that changes on a later render (e.g. `containsCurrent(item)` as the reader
   * navigates) still does not silently override what the reader has since opened or closed, matching
   * `WExpansionItem`'s own uncontrolled behavior of seeding once and then leaving the state alone.
   */
  function isOpen(id, defaultValue = false) {
    return state.has(id) ? state.get(id) : defaultValue
  }

  /** Records this item's open/closed state, keyed by id. */
  function setOpen(id, value) {
    state.set(id, value)
  }

  return { isOpen, setOpen }
}
