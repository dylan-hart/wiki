import { ref } from 'vue'

/**
 * Whether any Profile dialog section currently has a save/write request in flight (OpenProject
 * #3282) -- the guard `ProfileOverlay.vue`'s close button and `MainOverlayDialog.vue`'s dismiss
 * handler both read before letting the dialog close.
 *
 * Module singleton, mirroring `composables/loading.js`'s shape (a shared ref every write action
 * increments/decrements around its own request), but for a different purpose and with two
 * deliberate differences that make `loading.js` itself unusable here:
 *   - `loading.js` is app-wide, shared by unrelated features -- raising it for a Profile save would
 *     show its full-screen overlay for a reason that has nothing to do with it, and hide someone
 *     else's reason for showing it.
 *   - `loading.js` only flips its `isActive` flag true 500ms after `show()` (`DELAY`, there). A save
 *     that finishes inside that window -- the common case -- would never register, and a close
 *     attempted during it would go unblocked.
 *
 * A count, not a boolean: of the 6 Profile dialog sections, `ProfileAuth.vue` alone has 5 separate
 * write actions, and nothing stops two of them (or a write in one section racing the tail of a
 * previous one) from overlapping in flight.
 *
 * Imported directly by both `ProfileOverlay.vue` and `MainOverlayDialog.vue` rather than
 * provided/injected: `MainOverlayDialog.vue` is `ProfileOverlay.vue`'s *ancestor* (it renders
 * `ProfileOverlay.vue` as `overlays.Profile`), so `provide`/`inject` from the overlay could never
 * reach it -- injection only flows down the tree.
 *
 * Sections mount one at a time with no `keep-alive` (`ProfileOverlay.vue`'s `<component :is>`), so
 * switching tabs mid-save destroys whichever section's own local state tracked the request -- this
 * being a module singleton rather than a component-local `ref` is what keeps counting it correctly
 * through that unmount.
 */
export const pendingProfileSaves = ref(0)

export const profileSaving = {
  /** Call before starting a write request. */
  begin() {
    pendingProfileSaves.value++
  },
  /** Call once a write request settles, success or failure alike. */
  end() {
    pendingProfileSaves.value = Math.max(0, pendingProfileSaves.value - 1)
  }
}
