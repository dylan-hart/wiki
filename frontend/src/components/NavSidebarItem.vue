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
    :style="depthStyle"
    :class="{ 'is-graph-anchor': isAnchor(item) }"
    :model-value="isOpen(item.id, item.expandByDefault || containsCurrent(item))"
    @update:model-value="setOpen(item.id, $event)"
    @click.capture="handleHeaderClick($event, item)">
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

// -> Self-imported so the recursive tag below resolves explicitly, rather than relying on the SFC
//    filename-based self-reference Vue infers implicitly for `<script setup>` components
import NavSidebarItem from './NavSidebarItem.vue'

const props = defineProps({
  /** One nav item -- a `link`, possibly carrying `children` of its own. */
  item: {
    type: Object,
    required: true
  },
  /**
   * How many `.w-expansion-item__content` indent lanes enclose THIS row -- 0 for a row rendered
   * directly under the sidebar root (`NavSidebar.vue`'s own `v-for`, which passes no `depth` at
   * all), incremented by exactly 1 on each recursive `nav-sidebar-item` call below. This used to be
   * a pure DOM side effect with no numeric value anywhere to reach for (OpenProject #2932): the
   * hover depth-cue dots need an EXACT per-row lane count, not just "is there at least one
   * ancestor", so it is threaded explicitly as a prop rather than re-derived from nesting.
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

// HEADER CLICK DISPATCH: SHIFT+CLICK ISOLATE (OpenProject #2848/#3057/#3062) AND CTRL+CLICK
// EXPAND/COLLAPSE CYCLE (OpenProject #2847)

/**
 * Is the row that owns this component instance the one actually clicked? Shared by both branches
 * below (isolate and the ctrl+click cycle), since both are bound to the same capture-phase
 * `@click.capture` on this row's own `<w-expansion-item>` root (see the template) and both need to
 * be told apart from an ancestor or descendant folder's identical listener seeing the same bubbling
 * native event.
 *
 * `.w-expansion-item__header` is that row's own class (`WExpansionItem.vue`); content -- a child
 * leaf's own link, or a nested folder's header -- lives in a sibling `.w-expansion-item__content`,
 * never inside the header, so a click anywhere in THIS folder's content (or on a folder nested
 * inside it) fails this check and is correctly left alone. And because `.capture` visits ancestors
 * OUTERMOST-first -- the opposite order from a bubble-phase listener -- "first listener sees it
 * wins" (which the old bubble-phase middle-click isolate could lean on) does not hold here: every
 * ancestor folder up to the sidebar root carries this exact same capture listener on its OWN root
 * (this component recurses), so each instance must check whether the ACTUALLY clicked header's
 * nearest owning `.w-expansion-item` (`event.target.closest(...)`) is THIS instance's own root
 * (`event.currentTarget`, which a native capture-phase listener always reports as the exact node
 * it is attached to). Only the genuinely clicked instance matches and acts; every ancestor's check
 * fails and it does nothing, leaving capture free to keep travelling inward until it reaches the
 * real target.
 */
function ownsClickedHeader(event) {
  const header = event.target.closest('.w-expansion-item__header')
  return Boolean(header) && header.closest('.w-expansion-item') === event.currentTarget
}

/**
 * Isolate this folder: opens it and its ancestor chain, and collapses every OTHER folder in the
 * whole tree (`siteStore.nav.items`, not just this row's own subtree) -- except when the folder is
 * already open, which instead just closes it alone, leaving every other folder's state untouched,
 * exactly like a plain left click would (closing an already-open folder is not "opening" it, so
 * there is nothing to isolate).
 *
 * Triggered by shift+click by default, or by a bare left-click once the profile toggle
 * (`isolateOnLeftClick()`, OpenProject #3062) is switched on -- see `handleHeaderClick` below for
 * which. Originally a middle-click gesture (OpenProject #2848); middle-click no longer triggers
 * this at all.
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
 * Ctrl+click's own reach limit (OpenProject #2909): the tree can nest up to `MAX_DEPTH` (10,
 * `backend/models/tree.ts`), and `descendantFolders` used to walk every one of those levels with no
 * ceiling at all -- on a massive instance, one ctrl+click could walk and toggle a huge subtree in a
 * single, very slow call. Capped to 3 levels BELOW the clicked node, not 3 levels from the overall
 * tree root -- a click 3 levels down still expands 3 further levels from wherever it was clicked.
 * Deeper folders stay collapsed; the reader can ctrl+click again further down to keep expanding
 * incrementally.
 */
const MAX_EXPAND_CYCLE_DEPTH = 3

/**
 * Every folder (item carrying at least one child) in `item`'s own descendant subtree, recursively
 * -- NOT including `item` itself, and capped at `MAX_EXPAND_CYCLE_DEPTH` levels below it (see
 * above). Local to this cycle, and deliberately distinct from `navSidebarDestination.js`'s exported
 * `folderIds` (OpenProject #2848's whole-tree walk for shift+click isolate): that one walks a
 * top-level items array; this one walks a single folder's own `children`, which is what ctrl+click
 * cycling a subtree calls for. Returns full item objects rather than bare ids, since each one's own
 * `expandByDefault`/`containsCurrent` default is needed to read its CURRENT open/closed state
 * faithfully (see `runExpandCycle` below).
 *
 * `depth` counts levels already descended below the originally clicked node -- 0 on the initial
 * call, incremented once per recursive step -- and is never an absolute depth from the tree root.
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
 * `ownsClickedHeader`'s guard (see above) is what suppresses `WExpansionItem.vue`'s own unconditional
 * `@click="toggle"` on a ctrl+click: `handleHeaderClick` calls `preventDefault()`/`stopPropagation()`
 * on the shared capture-phase listener before this runs, which happens BEFORE the event ever reaches
 * the header's own bubble-phase `toggle()` binding.
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
 * The single `@click.capture` entry point for this row's header (see the template): decides which
 * of the two mutually-exclusive header gestures a click is, then runs it. Ctrl+click always wins and
 * always cycles (`runExpandCycle`), regardless of shift or the isolate-on-left-click toggle below --
 * the two gestures are not meant to combine. Otherwise, whether THIS click isolates
 * (`runIsolateClick`) depends on `isolateOnLeftClick()` (OpenProject #3062): OFF (the default) means
 * shift+click isolates and a bare click falls through to the regular toggle; ON swaps the two, so a
 * bare click isolates and shift+click falls through instead. "Falls through" means this function
 * simply returns without calling `preventDefault()`/`stopPropagation()`, leaving
 * `WExpansionItem.vue`'s own `@click="toggle"` free to run as it would with no listener here at all.
 *
 * That same fall-through is also where a plain click re-anchors the graph on this folder while
 * `/_graph` is open (OpenProject #3353) -- `reanchorGraphOnFolder()` no-ops everywhere else, so this
 * is safe to call unconditionally rather than threading another route check through this function.
 * Never called from the ctrl/shift branches above: the requested behavior is specifically a PLAIN
 * click re-anchoring, and expand-cycle/isolate keep their existing behavior unchanged.
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

// COMPUTED

/**
 * A right-click context menu only makes sense on an item backed by a real page/folder -- a
 * `generated` (auto/mixed-mode tree-walk) item, never a hand-authored `static` link, which may not
 * correspond to any page at all. Gated the same coarse "may they create pages somewhere" way the
 * toolbar's own "+ New Page" button already is -- real per-path enforcement stays server-side.
 */
const canCreate = computed(() => Boolean(props.item.generated) && userStore.can('write:pages'))

/**
 * The `--nav-depth` custom property NavSidebar.vue's hover depth-cue dot rule reads to size and
 * position itself (OpenProject #2932) -- set on this row's own root element so it is the value
 * actually read there, no matter how many ancestor `.content` wrappers it happens to inherit a
 * (now-overridden) value from. Bound on BOTH branches below: the leaf `<w-item>` directly, and the
 * folder `<w-expansion-item>` -- whose `style` fallthrough lands on its own single root element
 * (`.w-expansion-item`), a custom property inheriting from there down into that same component's
 * own internal header `<w-item class="w-expansion-item__header">`, which is what the dot rule
 * actually targets for a folder row.
 */
const depthStyle = computed(() => ({ '--nav-depth': String(props.depth) }))

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
