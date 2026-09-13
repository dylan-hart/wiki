<template>
  <li class="treeview-node" :style="indentStyle">
    <!-- NODE -->
    <!-- -> `tabindex`/`role`/`@keydown` give this row the same keyboard operability
            `NavSidebarItem.vue`'s `WItem`-based rows already have (OpenProject #3063) -- Enter/Space
            activates it exactly as a click would, modifiers included. -->
    <div
      class="treeview-label"
      tabindex="0"
      role="button"
      @click="handleLabelClick"
      @keydown="handleLabelKeydown"
      :class="{ active: isActive }">
      <!-- -> `color="slate-faint"` matches `NavSidebarItem.vue`'s own folder/page glyph exactly
              (OpenProject #3064) -- this row's icon otherwise drew at full row-ink strength, next
              to the main navbar's own muted tone. -->
      <w-icon :name="icon" size="sm" color="slate-faint" @click.stop="toggleNode()" />
      <div class="treeview-label-text">
        {{ displayMode === 'path' ? node.fileName : node.title }}
      </div>
      <w-spinner class="me-1" color="primary" v-if="state.isLoading" />
      <w-icon
        v-if="isActive"
        name="tabler:chevron-right"
        :color="dark.isActive ? `yellow-9` : `brown-4`" />
      <!-- RIGHT-CLICK MENU -->
      <w-menu
        v-if="contextActionList.length > 0"
        context-menu
        auto-close
        @before-show="state.isContextMenuShown = true"
        @before-hide="state.isContextMenuShown = false">
        <w-card class="p-2">
          <w-list dense style="min-width: 150px">
            <w-item
              v-for="action of contextActionList"
              :key="action.key"
              clickable
              @click="action.handler(node.id)">
              <w-item-section side>
                <w-icon :name="action.icon" :color="action.iconColor" />
              </w-item-section>
              <w-item-section :class="action.labelColor && `text-` + action.labelColor">{{
                action.label
              }}</w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </w-menu>
    </div>
    <!-- SUB-LEVEL -->
    <transition name="treeview">
      <tree-level
        v-if="hasChildren && isOpened"
        :parent-id="props.node.id"
        :depth="props.depth + 1" />
    </transition>
  </li>
</template>

<script setup>
import { computed, inject, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { isolateOnLeftClick } from '@/composables/navIsolatePreference'
import { descendantFolderIds, ancestorFolderIds } from '@/helpers/treeNodes'

import TreeLevel from './TreeLevel.vue'

// PROPS

const props = defineProps({
  depth: {
    type: Number,
    default: 0
  },
  node: {
    required: true,
    type: Object
  },
  parentId: {
    type: String,
    default: null
  }
})

// INJECT

const nodes = inject('nodes')
const loaded = inject('loaded')
const opened = inject('opened')
const displayMode = inject('displayMode')
const selection = inject('selection')
const emitLazyLoad = inject('emitLazyLoad')
const contextActionList = inject('contextActionList')

// DATA

const state = reactive({
  isContextMenuShown: false,
  isLoading: false
})

// COMPOSABLES

const dark = useDark()

// COMPUTED

/**
 * The `--tree-depth` custom property `TreeNav.vue`'s stylesheet reads for both this row's own
 * indentation (`.treeview-label`'s `padding-inline-start`) and its hover-only depth-cue dots (OpenProject
 * #3064) -- the same mechanism `NavSidebarItem.vue#depthStyle` sets `--nav-depth` with for the main
 * navbar, right down to set unconditionally (including at depth 0) rather than only past some
 * threshold, so the rule reading it never needs a fallback that could silently drift from what a
 * real depth-0 row computes anyway.
 *
 * Indentation used to be a correction instead: `.treeview-node`'s own `border-left` (2px) plus its
 * parent `.treeview-level`'s `padding-left` (19px) each applied once per nesting level as REAL DOM
 * offset, and `--indent` (`${depth * 21}px`) existed only to pull `.treeview-label`'s box back out
 * to the tree's true left edge so its `active`/hover background still spanned the full width
 * (OpenProject #853). Depth is now the only thing that indents a row at all -- there is no ancestor
 * offset left to correct for.
 */
const indentStyle = computed(() => ({ '--tree-depth': String(props.depth) }))

const icon = computed(() => {
  if (props.node.icon) {
    return props.node.icon
  }
  return isOpened.value ? 'tabler:folder-open' : 'tabler:folder'
})

const hasChildren = computed(() => {
  return props.node.children?.length > 0
})
const isOpened = computed(() => {
  return opened[props.node.id]
})
const isActive = computed(() => {
  return state.isContextMenuShown || selection.value === props.node.id
})

// METHODS

/**
 * Fetches this folder's own children if they haven't been fetched yet -- the lazy-load half of a
 * plain toggle, split out so the new isolate/cycle gestures below can force this folder open and
 * still trigger the same fetch a click would, rather than opening it onto whatever (possibly empty)
 * `children` it already happens to carry.
 */
async function ensureChildrenLoaded(isCurrent = false) {
  if (loaded[props.node.id]) {
    return
  }
  state.isLoading = true
  await Promise.race([
    new Promise((resolve, reject) => {
      emitLazyLoad(props.node.id, isCurrent, { done: resolve, fail: reject })
    }),
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('ERR_TREE_LOAD_TIMEOUT')), 30000)
    })
  ])
  loaded[props.node.id] = true
  state.isLoading = false
}

async function toggleNode(isCurrent = false) {
  opened[props.node.id] = !(opened[props.node.id] === true)
  if (opened[props.node.id]) {
    await ensureChildrenLoaded(isCurrent)
  }
}

function openNode() {
  selection.value = props.node.id
  if (selection.value !== props.node.id && opened[props.node.id]) {
    return
  }
  toggleNode(true)
}

/**
 * Ctrl+click expand/collapse cycle (OpenProject #3063, mirroring `NavSidebarItem.vue`'s
 * `runExpandCycle`/OpenProject #2847/#2890): a two-state cycle over this folder's own descendant
 * folders -- collapse them all if every one is currently open, otherwise expand them all -- and
 * this folder's OWN state is force-opened as part of the same cycle, never toggled, so the change
 * is always immediately visible even when there is nothing below it to cycle.
 */
async function runExpandCycle() {
  const descendants = descendantFolderIds(nodes, props.node.id)
  const allOpen = descendants.every((id) => Boolean(opened[id]))
  for (const id of descendants) {
    opened[id] = !allOpen
  }
  opened[props.node.id] = true
  await ensureChildrenLoaded()
}

/**
 * Isolate this folder (OpenProject #3063, mirroring `NavSidebarItem.vue`'s `runIsolateClick`/
 * OpenProject #2848/#3057/#3062): opens it and its ancestor chain, and collapses every OTHER known
 * folder in the tree -- except when it is already open, which instead just closes it alone, exactly
 * like a plain click would.
 *
 * Triggered by shift+click by default, or by a bare left-click once the shared
 * `isolateOnLeftClick()` profile toggle is switched on -- see `handleLabelClick` below for which.
 */
async function runIsolateClick() {
  const targetId = props.node.id
  if (opened[targetId]) {
    opened[targetId] = false
    return
  }
  const keepOpen = new Set([targetId, ...ancestorFolderIds(nodes, targetId)])
  for (const id of Object.keys(nodes ?? {})) {
    opened[id] = keepOpen.has(id)
  }
  await ensureChildrenLoaded()
}

/**
 * The single click entry point for this row's label (see the template): decides which of the three
 * mutually-exclusive gestures a click is, then runs it -- ctrl+click always wins and always cycles
 * (`runExpandCycle`), regardless of shift or the isolate-on-left-click toggle; otherwise whether
 * this click isolates (`runIsolateClick`) depends on `isolateOnLeftClick()`: OFF (the default) means
 * shift+click isolates and a bare click falls through to the existing `openNode()` (select + regular
 * toggle, entirely unchanged); ON swaps the two. Unlike `NavSidebarItem.vue`'s equivalent dispatcher,
 * this needs no capture-phase/`currentTarget` guard: this row owns exactly one native click listener
 * on its own element, with no nested component's own click binding to out-race.
 */
function handleLabelClick(event) {
  if (event.ctrlKey) {
    runExpandCycle()
    return
  }
  const shouldIsolate = isolateOnLeftClick() ? !event.shiftKey : event.shiftKey
  if (shouldIsolate) {
    runIsolateClick()
    return
  }
  openNode()
}

/** Keyboard parity for `handleLabelClick` above (OpenProject #3063), matching `WItem.vue`'s own
 *  Enter/Space handling -- modifiers held on the keypress carry through unchanged. */
function handleLabelKeydown(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    // -> Space would otherwise scroll the page
    event.preventDefault()
    handleLabelClick(event)
  }
}
</script>
