import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAdminStore } from '@/stores/admin'

/**
 * The route plumbing behind an admin list page whose rows open a full-screen edit overlay
 * (`/_admin/users/:id` -> `UserEditOverlay`, `/_admin/groups/:id` -> `GroupEditOverlay`).
 *
 * The overlay itself is mounted by `AdminLayout.vue` off `adminStore.overlay`, so a list page owns
 * only the two directions between that store field and its own route: an `:id` in the URL opens the
 * overlay (on mount and whenever the param changes), and the overlay closing sends the browser back
 * to the bare list and refreshes it. Both pages wrote the same four pieces out by hand.
 *
 * @param {object} opts
 * @param {string} opts.overlay The overlay component's registered name, as `AdminLayout.vue` keys it.
 * @param {string} opts.listPath Where to return once the overlay closes, e.g. `/_admin/users`.
 * @param {() => void} [opts.onClosed] Called after that return -- the page's own `load()`, so the
 *   list reflects whatever the overlay changed.
 */
export function useAdminOverlayRoute({ overlay, listPath, onClosed }) {
  const adminStore = useAdminStore()
  const router = useRouter()
  const route = useRoute()

  function checkOverlay() {
    if (route.params?.id) {
      adminStore.$patch({
        overlayOpts: { id: route.params.id },
        overlay
      })
    } else {
      adminStore.$patch({
        overlay: ''
      })
    }
  }

  watch(
    () => adminStore.overlay,
    (newValue, oldValue) => {
      if (newValue === '' && oldValue === overlay) {
        router.push(listPath)
        onClosed?.()
      }
    }
  )

  watch(() => route.params.id, checkOverlay)

  onMounted(checkOverlay)

  // -> The overlay is the layout's, not this page's: left set, it would still be mounted over
  //    whatever route the admin navigates to next.
  onBeforeUnmount(() => {
    adminStore.$patch({
      overlay: ''
    })
  })
}
