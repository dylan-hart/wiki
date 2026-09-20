import { ref, watch } from 'vue'

/**
 * The guard `ProfileOverlay.vue`'s close button and `MainOverlayDialog.vue`'s dismiss handler read
 * before letting the dialog close. Not `loading.js`: that one is app-wide (its full-screen overlay
 * would appear for an unrelated reason) and only flips true 500ms after `show()`, so a save that
 * settles inside that window -- the common case -- would never register.
 *
 * A module singleton rather than a component-local ref, because sections mount one at a time with no
 * `keep-alive` and switching tabs mid-save destroys whatever tracked the request. A count rather
 * than a boolean, because writes overlap. Imported directly rather than injected, because
 * `MainOverlayDialog.vue` is `ProfileOverlay.vue`'s ancestor and injection only flows down.
 */
export const pendingProfileSaves = ref(0)

export const profileSaving = {
  begin() {
    pendingProfileSaves.value++
  },
  end() {
    pendingProfileSaves.value = Math.max(0, pendingProfileSaves.value - 1)
  }
}

/**
 * DISPLAY-ONLY. `pendingProfileSaves` has to flip the instant a save starts, since it gates the
 * dismiss guard, but a save settling in the usual few hundred ms should not flash a "Saving..."
 * swap. Only showing is delayed; hiding follows the count immediately.
 */
export const isSavingVisible = ref(false)

const SAVING_VISIBLE_DELAY = 500

let savingVisibleTimer = null

watch(
  pendingProfileSaves,
  (count) => {
    if (count > 0) {
      // -> An overlapping second save must not restart the timer
      if (savingVisibleTimer === null && !isSavingVisible.value) {
        savingVisibleTimer = setTimeout(() => {
          savingVisibleTimer = null
          isSavingVisible.value = true
        }, SAVING_VISIBLE_DELAY)
      }
    } else {
      if (savingVisibleTimer !== null) {
        clearTimeout(savingVisibleTimer)
        savingVisibleTimer = null
      }
      isSavingVisible.value = false
    }
  },
  // -> `begin()`/`end()` are plain calls nobody awaits a tick for, so the timer has to start and
  //    cancel in the same tick the count changes rather than a microtask behind it
  { flush: 'sync' }
)
