import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAdminStore } from '@/stores/admin'

/**
 * `AdminLayout.vue` mounts the overlay itself off `adminStore.overlay`, so a list page owns only
 * the two directions between that store field and its own route.
 *
 * @param {object} opts
 * @param {string} opts.overlay The overlay component's registered name, as `AdminLayout.vue` keys it.
 * @param {string} opts.listPath
 * @param {() => void} [opts.onClosed] Called after the return to `listPath`.
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
