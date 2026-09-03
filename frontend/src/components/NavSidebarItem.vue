<template>
  <!-- -> Open from the start when the page being read is one of its descendants, so a reader arriving
          by URL sees where they are in the tree -- or when the menu says this group opens that way
          whatever is being read. Not `v-model`: after that first render the group is the reader's
          to open and close, and a bound value would fight them -->
  <w-expansion-item
    v-if="item.children?.length > 0"
    dense
    :default-opened="item.expandByDefault || containsCurrent(item)">
    <!-- The icon goes through a header slot rather than the `icon` prop, so that an Iconify -->
    <!-- reference is drawn by w-icon like everywhere else -->
    <template #header>
      <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
      <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
      <!-- -> Create inside this folder: right-click anywhere on its own header row -->
      <page-new-menu
        v-if="canCreate"
        context-menu
        :base-path="basePathFor(item)"
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(parentIdFor(item))" />
    </template>
    <w-list dense dark>
      <!-- -> One nav item, plus its own expansion behavior if it has children -- rendered for each
              child so a folder nested any number of levels deep still draws its own contents,
              rather than only the first level under the sidebar root -->
      <nav-sidebar-item v-for="child of item.children" :key="child.id" :item="child" />
    </w-list>
  </w-expansion-item>
  <w-item v-else v-bind="destination(item)">
    <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
    <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
    <!-- -> Create as a sibling, in the folder this page lives in: right-click anywhere on its row -->
    <page-new-menu
      v-if="canCreate"
      context-menu
      :base-path="basePathFor(item)"
      :hide-asset-btn="!canUploadAsset"
      @new-folder="openFolderDialog(parentIdFor(item))" />
  </w-item>
</template>

<script setup>
import { computed } from 'vue'

import { useNavSidebarDestination } from '@/composables/navSidebarDestination'
import { dialog } from '@/composables/dialog'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import PageNewMenu from '@/components/PageNewMenu.vue'

// -> Self-imported so the recursive tag below resolves explicitly, rather than relying on the SFC
//    filename-based self-reference Vue infers implicitly for `<script setup>` components
import NavSidebarItem from './NavSidebarItem.vue'

const props = defineProps({
  /** One nav item -- a `link`, possibly carrying `children` of its own. */
  item: {
    type: Object,
    required: true
  }
})

const { destination, containsCurrent } = useNavSidebarDestination()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// COMPUTED

/**
 * A right-click context menu only makes sense on an item backed by a real page/folder -- a
 * `generated` (auto/mixed-mode tree-walk) item, never a hand-authored `static` link, which may not
 * correspond to any page at all. Gated the same coarse "may they create pages somewhere" way the
 * toolbar's own "+ New Page" button already is -- real per-path enforcement stays server-side.
 */
const canCreate = computed(() => Boolean(props.item.generated) && userStore.can('write:pages'))
const canUploadAsset = computed(() => userStore.can('write:assets') || userStore.can('write:pages'))

// METHODS

/**
 * Where a creation action targets, for a generated item: right-click a FOLDER item (one with
 * children -- every generated folder item has at least one, or it would have been dropped) creates
 * INSIDE it; right-click a PAGE item creates as a SIBLING, in the folder it lives in.
 */
function basePathFor(item) {
  if (item.children?.length > 0) {
    return item.path ?? ''
  }
  const segments = (item.path ?? '').split('/')
  segments.pop()
  return segments.join('/')
}

/** The `parentId` a new FOLDER (not page) is created under -- see `basePathFor` above for the same
 *  inside-vs-sibling rule, addressed by id rather than path since folder creation takes a `parentId`. */
function parentIdFor(item) {
  return item.children?.length > 0 ? item.id : (item.folderId ?? null)
}

function openFolderDialog(parentId) {
  dialog({
    component: FolderCreateDialog,
    componentProps: { parentId }
  }).onOk(() => {
    siteStore.fetchNavigation(pageStore.navigationId, true)
  })
}
</script>
