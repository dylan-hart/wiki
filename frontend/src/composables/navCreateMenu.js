import { computed } from 'vue'

import { dialog } from '@/composables/dialog'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'

export function useNavCreateMenu() {
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  /** Either permission alone is enough, matching the toolbar's own "+ New Page" menu. */
  const canUploadAsset = computed(
    () => userStore.can('write:assets') || userStore.can('write:pages')
  )

  /** The trailing `true` is `fetchNavigation`'s `forceRefresh`: a new folder invalidates the cached
   *  nav tree, as every other nav-mutating action does. */
  function openFolderDialog(parentId) {
    dialog({
      component: FolderCreateDialog,
      componentProps: { parentId }
    }).onOk(() => {
      siteStore.fetchNavigation(pageStore.navigationId, true)
    })
  }

  return { canUploadAsset, openFolderDialog }
}
