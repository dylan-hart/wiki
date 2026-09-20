import { inject, provide, reactive } from 'vue'

/**
 * One reactive `Map` for the whole nav tree, keyed by nav item id, so a folder's open/closed state
 * survives that item's own unmount and remount -- which `WExpansionItem`'s uncontrolled
 * `default-opened` state, living on the component instance, does not. In memory for the lifetime of
 * the mounted tree; nothing is persisted.
 */
const NAV_EXPANSION_STATE_KEY = Symbol('navExpansionState')

/** Call once, from the tree's root component. */
export function useProvideNavExpansionState() {
  const state = reactive(new Map())
  provide(NAV_EXPANSION_STATE_KEY, state)
  return state
}

/**
 * Falls back to a fresh, unshared `Map` rather than throwing when no provider is present: an item
 * mounted standalone (a unit test) still needs working open/closed state.
 */
export function useNavExpansionState() {
  const state = inject(NAV_EXPANSION_STATE_KEY, null) ?? reactive(new Map())

  /**
   * A pure read: it never populates the map, so a `defaultValue` that re-evaluates differently on a
   * later render does not override what the reader has since opened or closed.
   */
  function isOpen(id, defaultValue = false) {
    return state.has(id) ? state.get(id) : defaultValue
  }

  function setOpen(id, value) {
    state.set(id, value)
  }

  return { isOpen, setOpen }
}
