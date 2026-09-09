<template>
  <!-- -> Open from the start when the page being read is one of its descendants, so a reader arriving
          by URL sees where they are in the tree -- or when the menu says this group opens that way
          whatever is being read. Controlled through the shared, tree-wide open/closed state
          (OpenProject #2846) rather than `default-opened`, so a folder's state survives its own
          unmount/remount -- but the state is still seeded from this same expression the first time
          this id is seen, and is the reader's to open and close after that (see
          `composables/navExpansionState.js#isOpen`) -->
  <w-expansion-item
    v-if="item.children?.length > 0"
    dense
    :model-value="isOpen(item.id, item.expandByDefault || containsCurrent(item))"
    @update:model-value="setOpen(item.id, $event)"
    @auxclick.middle="handleIsolateClick($event, item)"
    @click.capture="handleExpandCycleClick($event, item)">
    <!-- The icon goes through a header slot rather than the `icon` prop, so that an Iconify -->
    <!-- reference is drawn by w-icon like everywhere else -->
    <template #header>
      <w-item-section side><w-icon :name="iconFor(item)" color="slate-faint" /></w-item-section>
      <w-item-section>
        <span ref="labelEl" class="truncate">{{ displayLabel(item) }}</span>
        <!-- -> Only when the label is actually clipped -- see `checkTruncation` below -->
        <w-tooltip v-if="isTruncated">{{ displayLabel(item) }}</w-tooltip>
      </w-item-section>
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
    <w-item-section>
      <span ref="labelEl" class="truncate">{{ displayLabel(item) }}</span>
      <!-- -> Only when the label is actually clipped -- see `checkTruncation` below -->
      <w-tooltip v-if="isTruncated">{{ displayLabel(item) }}</w-tooltip>
    </w-item-section>
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { useNavCreateMenu } from '@/composables/navCreateMenu'
import { useNavExpansionState } from '@/composables/navExpansionState'
import {
  ancestorIds,
  folderIds,
  useNavSidebarDestination
} from '@/composables/navSidebarDestination'
import { usePathDisplay } from '@/composables/pathDisplay'

import { useSiteStore } from '@/stores/site'
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

const { destination, containsCurrent } = useNavSidebarDestination()
const { canUploadAsset, openFolderDialog } = useNavCreateMenu()
const { isActive: pathDisplayActive, humanize } = usePathDisplay()
const { isOpen, setOpen } = useNavExpansionState()

/**
 * What glyph a row draws. A nav item's own `icon` when it has one, and otherwise the same pair the
 * design gives the tree: a folder for a folder row (empty or not -- `item.isFolder`, since an empty
 * or boundary folder carries no `children` of its own to infer it from), a page for a leaf, and
 * `folder-open` in place of `folder` while that folder is currently expanded (read off the same
 * shared, tree-wide expansion state the row's own `w-expansion-item` binds to -- see the template's
 * own comment).
 *
 * The fallback is what makes an AUTO-generated menu look like the design at all -- a generated item
 * carries no icon of its own, so every row drew an empty 15px gap where the tree's own shape should
 * be readable at a glance.
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

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// MIDDLE-CLICK ISOLATE (OpenProject #2848)

/**
 * Middle-click a folder's own header row: toggles it exactly like a plain left click would --
 * closing it alone, and leaving every other folder's state untouched, when it is already open --
 * except that OPENING it also isolates: it and its ancestor chain end up open, and every OTHER
 * folder in the whole tree (`siteStore.nav.items`, not just this row's own subtree) collapses.
 * Bound to `auxclick` rather than `click` -- a non-primary mouse button fires `auxclick`, never `click`, in
 * every evergreen browser (Chromium, Firefox, WebKit all follow the UI Events spec here), and the
 * `.middle` modifier narrows it to button 1 alone so a right-click's `auxclick`/`contextmenu` does
 * not also trigger this.
 *
 * `@auxclick.middle` is bound on the whole `<w-expansion-item>` (see the template), whose single
 * root element wraps BOTH the header row and this folder's own (possibly open) content -- Vue's
 * attrs fallthrough has nowhere narrower to attach to without restructuring `WExpansionItem.vue`'s
 * markup. So a middle-click anywhere in this folder's content -- a child leaf's own link, or a
 * nested folder's header, which handles its own isolate and stops the event there before it can
 * reach here -- bubbles up to this same listener too and must be told apart from an actual click on
 * THIS row's own header, or it would misfire as if this folder had been clicked, and -- worse --
 * call `preventDefault()` on a leaf link's native middle-click-opens-a-new-tab behavior.
 * `.w-expansion-item__header` is that row's own class (`WExpansionItem.vue`); content lives in a
 * sibling `.w-expansion-item__content`, never inside the header, so `closest()` from the real click
 * target reliably tells the two apart.
 */
function handleIsolateClick(event, item) {
  if (!event.target.closest('.w-expansion-item__header')) {
    return
  }
  // -> Scoped to this header alone: never touches the `v-else` leaf branch's own link, and
  //    stopPropagation keeps a click on a nested folder's header (already handled there) or on this
  //    folder's own content from re-triggering an ancestor folder's identical listener above it.
  event.preventDefault()
  event.stopPropagation()
  const currentlyOpen = isOpen(item.id, item.expandByDefault || containsCurrent(item))
  if (currentlyOpen) {
    // -> The closing half of the toggle: exactly a left click's own `@update:model-value`, and
    //    nothing else -- no isolation, since closing a folder that was open is not "opening" it.
    setOpen(item.id, false)
    return
  }
  const items = siteStore.nav.items
  const openIds = new Set([item.id, ...ancestorIds(items, item.id)])
  for (const id of folderIds(items)) {
    setOpen(id, openIds.has(id))
  }
}

// CTRL+CLICK EXPAND/COLLAPSE CYCLE (OpenProject #2847)

/**
 * Every folder (item carrying at least one child) in `item`'s own descendant subtree, recursively
 * -- NOT including `item` itself. Local to this cycle, and deliberately distinct from
 * `navSidebarDestination.js`'s exported `folderIds` (OpenProject #2848's whole-tree walk for
 * middle-click isolate): that one walks a top-level items array; this one walks a single folder's
 * own `children`, which is what ctrl+click cycling a subtree calls for. Returns full item objects
 * rather than bare ids, since each one's own `expandByDefault`/`containsCurrent` default is needed
 * to read its CURRENT open/closed state faithfully (see `handleExpandCycleClick` below).
 */
function descendantFolders(item) {
  const folders = []
  for (const child of item.children ?? []) {
    if (child.children?.length > 0) {
      folders.push(child, ...descendantFolders(child))
    }
  }
  return folders
}

/**
 * Ctrl+click a folder's own header row: a two-state cycle over its own descendant folders (Feature
 * #2829's design section) -- collapse them all if every one is currently open, otherwise expand
 * them all. The clicked folder's OWN state is force-opened as part of the same cycle (OpenProject
 * #2890) -- never toggled -- so the descendant-state change this produces is always immediately
 * visible, rather than silently happening behind a still-closed parent, and so ctrl+click behaves
 * consistently even on a folder with no sub-folder descendants at all (previously a hard no-op,
 * since there was nothing for the descendant cycle to act on and the folder itself never opened).
 * Forcing open rather than toggling matters: toggling would let a ctrl+click on an already-open
 * folder collapse the very folder whose contents it was meant to reveal.
 *
 * Bound with `.capture`, not a plain bubble listener, and that is load-bearing:
 * `WExpansionItem.vue`'s header binds an unconditional `@click="toggle"` directly on
 * `.w-expansion-item__header`, which -- being the actual click target -- fires before any
 * bubble-phase listener an ANCESTOR of it could register. A bubble-phase handler here would always
 * run too late, after toggle() had already flipped this row. Capturing instead lets this handler
 * run, and call `stopPropagation()`, BEFORE the event ever reaches the header, which is what
 * suppresses toggle() on a ctrl+click.
 *
 * That in turn means every ancestor folder up to the sidebar root carries this exact same capture
 * listener on its OWN `<w-expansion-item>` root (this component recurses), and capture fires
 * outermost-first -- the opposite order from `handleIsolateClick`'s bubble-based scoping above. So
 * this cannot lean on "first listener to see it wins" the way that one does: an ancestor's handler
 * would otherwise claim a click meant for one of its own nested folders. Instead, each instance
 * checks whether the ACTUALLY clicked header's nearest owning `.w-expansion-item`
 * (`event.target.closest(...)`) is this instance's own root (`event.currentTarget`, which a native
 * capture-phase listener always reports as the exact node it is attached to). Only the genuinely
 * clicked instance matches and acts; every ancestor's check fails and it does nothing, leaving
 * capture free to keep travelling inward until it reaches the real target.
 */
function handleExpandCycleClick(event, item) {
  if (!event.ctrlKey) {
    return
  }
  const header = event.target.closest('.w-expansion-item__header')
  if (!header || header.closest('.w-expansion-item') !== event.currentTarget) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const folders = descendantFolders(item)
  const allOpen = folders.every((folder) =>
    isOpen(folder.id, folder.expandByDefault || containsCurrent(folder))
  )
  for (const folder of folders) {
    setOpen(folder.id, !allOpen)
  }
  setOpen(item.id, true)
}

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

// TRUNCATION / TOOLTIP (OpenProject #2849)

/**
 * The label element currently rendered -- either the `w-expansion-item` header's or the leaf
 * `w-item`'s, since the two are mutually exclusive per instance (`v-if`/`v-else` above), so one ref
 * name safely serves both.
 */
const labelEl = ref(null)

/** Whether the label is currently clipped by its own single-line ellipsis. */
const isTruncated = ref(false)

/**
 * `scrollWidth` still reports the label's full, untruncated content width even while visually
 * clipped -- a mismatch against `clientWidth` (what actually fits) is truncation. Exposed so the
 * test file can trigger it directly after stubbing both widths on `labelEl`: neither jsdom nor
 * happy-dom runs real layout, so a `ResizeObserver` callback never fires on its own under test.
 */
function checkTruncation() {
  isTruncated.value = Boolean(
    labelEl.value && labelEl.value.scrollWidth > labelEl.value.clientWidth
  )
}

let resizeObserver = null

// Re-measures whenever the label's own box changes width -- a window resize, the sidebar being
// resized (including a future auto-growing width, OpenProject #2850), or a folder collapsing
// elsewhere in the tree and giving this row more room back.
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

// Re-measures on a content-only change too (e.g. the path-display setting toggling) -- the box
// itself may not resize, so the ResizeObserver above would never fire for this on its own.
watch(
  () => displayLabel(props.item),
  () => nextTick(checkTruncation)
)

defineExpose({ checkTruncation })

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
