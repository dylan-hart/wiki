<template>
  <!-- -> This expression only seeds the open state the first time this id is seen; the shared,
          tree-wide state (`composables/navExpansionState.js`) owns it afterwards, which is why it is
          bound here rather than through `default-opened` -- a folder's state has to survive its own
          unmount/remount -->
  <w-expansion-item
    v-if="item.children?.length > 0"
    dense
    :style="depthStyle"
    :class="{ 'is-graph-anchor': isAnchor(item) }"
    :model-value="isOpen(item.id, item.expandByDefault || containsCurrent(item))"
    @update:model-value="setOpen(item.id, $event)"
    @click.capture="handleHeaderClick($event, item)">
    <!-- Header slot rather than the `icon` prop, so an Iconify reference is drawn by w-icon -->
    <template #header>
      <w-item-section side><w-icon :name="iconFor(item)" color="slate-faint" /></w-item-section>
      <w-item-section>
        <span ref="labelEl" class="truncate">{{ displayLabel(item) }}</span>
        <w-tooltip v-if="isTruncated">{{ displayLabel(item) }}</w-tooltip>
      </w-item-section>
      <page-new-menu
        v-if="canCreate"
        context-menu
        show-new-folder
        :base-path="basePathFor(item)"
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(parentIdFor(item))" />
    </template>
    <w-list dense>
      <nav-sidebar-item
        v-for="child of item.children"
        :key="child.id"
        :item="child"
        :depth="depth + 1" />
    </w-list>
  </w-expansion-item>
  <w-item
    v-else
    v-bind="destination(item)"
    :style="depthStyle"
    :class="{ 'is-graph-anchor': isAnchor(item), 'is-graph-selected': isSelected(item) }">
    <w-item-section side><w-icon :name="iconFor(item)" color="slate-faint" /></w-item-section>
    <w-item-section>
      <span ref="labelEl" class="truncate">{{ displayLabel(item) }}</span>
      <w-tooltip v-if="isTruncated">{{ displayLabel(item) }}</w-tooltip>
    </w-item-section>
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { useNavCreateMenu } from '@/composables/navCreateMenu'
import { useNavExpansionState } from '@/composables/navExpansionState'
import { isolateOnLeftClick } from '@/composables/navIsolatePreference'
import {
  ancestorIds,
  folderIds,
  useNavSidebarDestination
} from '@/composables/navSidebarDestination'
import { usePathDisplay } from '@/composables/pathDisplay'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PageNewMenu from '@/components/PageNewMenu.vue'

// -> Self-imported so the recursive tag below resolves explicitly rather than through the implicit
//    filename-based self-reference
import NavSidebarItem from './NavSidebarItem.vue'

const props = defineProps({
  item: {
    type: Object,
    required: true
  },
  /**
   * How many `.w-expansion-item__content` indent lanes enclose THIS row. Threaded explicitly rather
   * than re-derived from nesting: the hover depth-cue dots need an exact per-row lane count, not
   * just "is there at least one ancestor".
   */
  depth: {
    type: Number,
    default: 0
  }
})

const { destination, containsCurrent, isAnchor, isSelected, reanchorGraphOnFolder } =
  useNavSidebarDestination()
const { canUploadAsset, openFolderDialog } = useNavCreateMenu()
const { isActive: pathDisplayActive, humanize } = usePathDisplay()
const { isOpen, setOpen } = useNavExpansionState()

/**
 * `item.isFolder` as well as `children?.length`: an empty or boundary folder carries no `children`
 * to infer folder-ness from. The fallback pair is what gives an AUTO-generated menu any glyph at
 * all -- a generated item carries no icon of its own.
 */
function iconFor(item) {
  if (item.icon) {
    return item.icon
  }
  const isFolder = item.isFolder || item.children?.length > 0
  if (!isFolder) {
    return 'tabler:file-text'
  }
  return isOpen(item.id, item.expandByDefault || containsCurrent(item))
    ? 'tabler:folder-open'
    : 'tabler:folder'
}

const siteStore = useSiteStore()
const userStore = useUserStore()

/**
 * Whether THIS instance's row is the one actually clicked. The component recurses, so every ancestor
 * folder carries the same capture-phase listener on its own root, and `.capture` visits them
 * outermost-first -- "the first listener to see it wins" does not hold. Comparing the clicked
 * header's owning `.w-expansion-item` against `event.currentTarget` (always the node a capture
 * listener is attached to) lets only the real target act, leaving capture free to keep travelling
 * inward.
 */
function ownsClickedHeader(event) {
  const header = event.target.closest('.w-expansion-item__header')
  return Boolean(header) && header.closest('.w-expansion-item') === event.currentTarget
}

/**
 * The collapse covers the whole tree, not just this row's own subtree. An already-open folder
 * instead just closes, exactly as a plain left click would -- closing is not "opening", so there is
 * nothing to isolate.
 */
function runIsolateClick(item) {
  const currentlyOpen = isOpen(item.id, item.expandByDefault || containsCurrent(item))
  if (currentlyOpen) {
    setOpen(item.id, false)
    return
  }
  const items = siteStore.nav.items
  const openIds = new Set([item.id, ...ancestorIds(items, item.id)])
  for (const id of folderIds(items)) {
    setOpen(id, openIds.has(id))
  }
}

/**
 * Ctrl+click's reach limit -- an uncapped descendant walk can toggle a huge subtree in one slow
 * call. Counted BELOW the clicked node rather than from the tree root, so a deep click still expands
 * three further levels; the reader ctrl+clicks again to keep going.
 */
const MAX_EXPAND_CYCLE_DEPTH = 3

/**
 * Returns whole items rather than bare ids: reading a folder's CURRENT open state needs its own
 * `expandByDefault`/`containsCurrent` default. `depth` counts levels already descended below the
 * originally clicked node, never an absolute depth from the tree root.
 */
function descendantFolders(item, depth = 0) {
  if (depth >= MAX_EXPAND_CYCLE_DEPTH) {
    return []
  }
  const folders = []
  for (const child of item.children ?? []) {
    if (child.children?.length > 0) {
      folders.push(child, ...descendantFolders(child, depth + 1))
    }
  }
  return folders
}

/**
 * The clicked folder's own state is forced open rather than toggled, so the descendant change is
 * always visible instead of happening behind a still-closed parent, and so a folder with no
 * sub-folders is not a no-op. Toggling would let a ctrl+click on an already-open folder collapse the
 * very folder whose contents it was meant to reveal.
 */
function runExpandCycle(item) {
  const folders = descendantFolders(item)
  const allOpen = folders.every((folder) =>
    isOpen(folder.id, folder.expandByDefault || containsCurrent(folder))
  )
  for (const folder of folders) {
    setOpen(folder.id, !allOpen)
  }
  setOpen(item.id, true)
}

/**
 * Ctrl+click always wins over shift and the isolate-on-left-click toggle -- the gestures are not
 * meant to combine. `isolateOnLeftClick()` decides which of the remaining two isolates and which
 * falls through; "falls through" means returning without `preventDefault()`/`stopPropagation()`, so
 * `WExpansionItem.vue`'s own `@click="toggle"` runs as if no listener were here at all.
 * `reanchorGraphOnFolder()` no-ops off `/_graph`, so the plain-click path calls it unconditionally
 * rather than threading a route check through here.
 */
function handleHeaderClick(event, item) {
  if (!ownsClickedHeader(event)) {
    return
  }
  if (event.ctrlKey) {
    event.preventDefault()
    event.stopPropagation()
    runExpandCycle(item)
    return
  }
  const shouldIsolate = isolateOnLeftClick() ? !event.shiftKey : event.shiftKey
  if (shouldIsolate) {
    event.preventDefault()
    event.stopPropagation()
    runIsolateClick(item)
    return
  }
  reanchorGraphOnFolder(item)
}

/**
 * A right-click context menu only makes sense on an item backed by a real page/folder -- a
 * `generated` (auto/mixed-mode tree-walk) item, never a hand-authored `static` link, which may not
 * correspond to any page at all. Gated the same coarse "may they create pages somewhere" way the
 * toolbar's "+ New Page" button is -- real per-path enforcement stays server-side.
 */
const canCreate = computed(() => Boolean(props.item.generated) && userStore.can('write:pages'))

/**
 * `--nav-depth` is what `NavSidebar.vue`'s hover depth-cue dot rule reads to size and position
 * itself. Set on this row's own root so it overrides whatever an ancestor wrapper inherits down; on
 * the folder branch the `style` fallthrough lands on `.w-expansion-item` and the custom property
 * inherits into that component's internal header row, which is what the dot rule targets.
 */
const depthStyle = computed(() => ({ '--nav-depth': String(props.depth) }))

/**
 * A hand-authored `static` link keeps its own label whatever the path-display setting says, since it
 * may not correspond to a real path at all. For a `generated` item the humanized segment is a
 * deliberate override of the row's title, not a fallback for a missing one.
 */
function displayLabel(item) {
  if (!pathDisplayActive.value || !item.generated || !item.path) {
    return item.label
  }
  const segments = item.path.split('/')
  return humanize(segments[segments.length - 1])
}

/** One ref name serves both branches: the `v-if`/`v-else` above keeps them mutually exclusive. */
const labelEl = ref(null)

const isTruncated = ref(false)

/**
 * `scrollWidth` still reports the label's full content width even while visually clipped, so a
 * mismatch against `clientWidth` is truncation. Exposed so a test can trigger it after stubbing both
 * widths: neither jsdom nor happy-dom runs real layout, so `ResizeObserver` never fires there.
 */
function checkTruncation() {
  isTruncated.value = Boolean(
    labelEl.value && labelEl.value.scrollWidth > labelEl.value.clientWidth
  )
}

let resizeObserver = null

watch(labelEl, (el) => {
  resizeObserver?.disconnect()
  if (!el) {
    isTruncated.value = false
    return
  }
  checkTruncation()
  resizeObserver = new ResizeObserver(checkTruncation)
  resizeObserver.observe(el)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

// A content-only change (the path-display setting toggling) need not resize the box, so the
// ResizeObserver above would never fire for it.
watch(
  () => displayLabel(props.item),
  () => nextTick(checkTruncation)
)

defineExpose({ checkTruncation })

/**
 * Right-click a FOLDER item creates INSIDE it; right-click a PAGE item creates as a SIBLING. The
 * folder test is `!item.target` rather than `children?.length`, because a boundary folder (one with
 * its own navigation override) is deliberately generated with no `children` and would otherwise be
 * misclassified as a page.
 */
function basePathFor(item) {
  if (!item.target) {
    return item.path ?? ''
  }
  const segments = (item.path ?? '').split('/')
  segments.pop()
  return segments.join('/')
}

function parentIdFor(item) {
  return !item.target ? item.id : (item.folderId ?? null)
}
</script>
