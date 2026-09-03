import { computed } from 'vue'

import { dialog } from '@/composables/dialog'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'

/**
 * The bits of a `PageNewMenu` right-click context menu that are identical wherever one is rendered
 * -- once on the folder/page rows `NavSidebarItem.vue` draws (create inside/as-a-sibling) and once
 * on `NavSidebar.vue`'s own empty-space root menu (create at the locale root). Kept as a composable
 * rather than duplicated per component, the same way `useNavSidebarDestination()` is: every call
 * site shares one implementation instead of each closing over its own copy.
 */
export function useNavCreateMenu() {
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  /** Whether the asset-upload item belongs on a `PageNewMenu` here: either permission alone is
   *  enough, matching the toolbar's own "+ New Page" menu. */
  const canUploadAsset = computed(
    () => userStore.can('write:assets') || userStore.can('write:pages')
  )

  /** Opens `FolderCreateDialog` under `parentId`, refreshing the sidebar's own nav tree once the
   *  folder is actually created -- the same `forceRefresh` invalidation every other nav-mutating
   *  action (a nav edit, a copy, a page create/move/delete) already goes through. */
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
