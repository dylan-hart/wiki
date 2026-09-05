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
      <w-item-section side><w-icon :name="iconFor(item)" color="slate-faint" /></w-item-section>
      <w-item-section class="text-wordbreak-all">{{ displayLabel(item) }}</w-item-section>
      <!-- -> Create inside this folder: right-click anywhere on its own header row -->
      <page-new-menu
        v-if="canCreate"
        context-menu
        show-new-folder
        :base-path="basePathFor(item)"
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(parentIdFor(item))" />
    </template>
    <w-list dense>
      <!-- -> One nav item, plus its own expansion behavior if it has children -- rendered for each
              child so a folder nested any number of levels deep still draws its own contents,
              rather than only the first level under the sidebar root -->
      <nav-sidebar-item v-for="child of item.children" :key="child.id" :item="child" />
    </w-list>
  </w-expansion-item>
  <w-item v-else v-bind="destination(item)">
    <w-item-section side><w-icon :name="iconFor(item)" color="slate-faint" /></w-item-section>
    <w-item-section class="text-wordbreak-all">{{ displayLabel(item) }}</w-item-section>
    <!-- -> Create as a sibling, in the folder this page lives in: right-click anywhere on its row -->
    <page-new-menu
      v-if="canCreate"
      context-menu
      show-new-folder
      :base-path="basePathFor(item)"
      :hide-asset-btn="!canUploadAsset"
      @new-folder="openFolderDialog(parentIdFor(item))" />
  </w-item>
</template>

<script setup>
import { computed } from 'vue'

import { useNavCreateMenu } from '@/composables/navCreateMenu'
import { useNavSidebarDestination } from '@/composables/navSidebarDestination'
import { usePathDisplay } from '@/composables/pathDisplay'

import { useUserStore } from '@/stores/user'

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

/**
 * What glyph a row draws. A nav item's own `icon` when it has one, and otherwise the same pair the
 * design gives the tree: a folder for a row with children under it, a page for a leaf.
 *
 * The fallback is what makes an AUTO-generated menu look like the design at all -- a generated item
 * carries no icon of its own, so every row drew an empty 15px gap where the tree's own shape should
 * be readable at a glance.
 */
function iconFor(item) {
  if (item.icon) {
    return item.icon
  }
  return item.children?.length > 0 ? 'tabler:folder' : 'tabler:file-text'
}

const { destination, containsCurrent } = useNavSidebarDestination()
const { canUploadAsset, openFolderDialog } = useNavCreateMenu()
const { isActive: pathDisplayActive, humanize } = usePathDisplay()

// STORES

const userStore = useUserStore()

// COMPUTED

/**
 * A right-click context menu only makes sense on an item backed by a real page/folder -- a
 * `generated` (auto/mixed-mode tree-walk) item, never a hand-authored `static` link, which may not
 * correspond to any page at all. Gated the same coarse "may they create pages somewhere" way the
 * toolbar's own "+ New Page" button already is -- real per-path enforcement stays server-side.
 */
const canCreate = computed(() => Boolean(props.item.generated) && userStore.can('write:pages'))

// METHODS

/**
 * The label an item draws (Feature #2574/#2578): the site's humanized last path segment for a
 * `generated` (auto/mixed tree-walk) item when the path-display setting is on, or `item.label`
 * unchanged otherwise -- a hand-authored `static` link (never `generated`) always keeps its own
 * label, since it may not correspond to a real path at all. A deliberate override of the tree
 * row's own title, not a fallback for a missing one -- see the parent Feature's own scope note.
 */
function displayLabel(item) {
  if (!pathDisplayActive.value || !item.generated || !item.path) {
    return item.label
  }
  const segments = item.path.split('/')
  return humanize(segments[segments.length - 1])
}

/**
 * Where a creation action targets, for a generated item: right-click a FOLDER item creates INSIDE
 * it; right-click a PAGE item creates as a SIBLING, in the folder it lives in. A generated PAGE
 * item always carries `target` (only `row.type === 'page'` rows get one from `generateFromTree`);
 * a generated FOLDER item never does -- including a boundary folder (one with its own navigation
 * override), which `generateFromTree` deliberately gives no `children`, so `children?.length > 0`
 * would misclassify it as a leaf/page. `!item.target` is correct for both the ordinary and the
 * boundary case.
 */
function basePathFor(item) {
  if (!item.target) {
    return item.path ?? ''
  }
  const segments = (item.path ?? '').split('/')
  segments.pop()
  return segments.join('/')
}

/** The `parentId` a new FOLDER (not page) is created under -- see `basePathFor` above for the same
 *  inside-vs-sibling rule, addressed by id rather than path since folder creation takes a `parentId`. */
function parentIdFor(item) {
  return !item.target ? item.id : (item.folderId ?? null)
}
</script>
