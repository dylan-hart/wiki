<template>
  <li class="treeview-node" :style="indentStyle">
    <div
      class="treeview-label"
      tabindex="0"
      role="button"
      @click="handleLabelClick"
      @keydown="handleLabelKeydown"
      :class="{ active: isActive }">
      <!-- -> `slate-faint` holds this glyph at the main navbar's muted tone rather than full row
              ink, so the two trees read alike. -->
      <w-icon :name="icon" size="sm" color="slate-faint" @click.stop="toggleNode()" />
      <div class="treeview-label-text">
        {{ displayMode === 'path' ? node.fileName : node.title }}
      </div>
      <w-spinner class="me-1" color="primary" v-if="state.isLoading" />
      <w-icon
        v-if="isActive"
        name="tabler:chevron-right"
        :color="dark.isActive ? `yellow-9` : `brown-4`" />
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
    <!-- -> Bare `v-if`, no animation wrapper: expand/collapse is instant, matching the main
            navbar's own children. -->
    <tree-level
      v-if="hasChildren && isOpened"
      :parent-id="props.node.id"
      :depth="props.depth + 1" />
  </li>
</template>

<script setup>
import { computed, inject, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { isolateOnLeftClick } from '@/composables/navIsolatePreference'
import { descendantFolderIds, ancestorFolderIds } from '@/helpers/treeNodes'

import TreeLevel from './TreeLevel.vue'

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

const nodes = inject('nodes')
const loaded = inject('loaded')
const opened = inject('opened')
const displayMode = inject('displayMode')
const selection = inject('selection')
const emitLazyLoad = inject('emitLazyLoad')
const contextActionList = inject('contextActionList')

const state = reactive({
  isContextMenuShown: false,
  isLoading: false
})

const dark = useDark()

/**
 * `TreeNav.vue`'s stylesheet reads `--tree-depth` for both this row's indentation and its depth-cue
 * dots. Set unconditionally, including at depth 0, so those rules never rely on a fallback value
 * that could drift from what a real depth-0 row computes.
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

/**
 * Split out of the plain toggle so the isolate and cycle gestures can force a folder open and still
 * trigger the same fetch a click would, rather than opening it onto stale `children`.
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
 * This folder's own state is force-opened rather than toggled, so the gesture stays visible even on
 * a folder with nothing below it to cycle.
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
 * The three gestures are mutually exclusive and ordered: ctrl+click always cycles, whatever shift
 * or the isolate-on-left-click toggle say. The toggle then swaps which of shift+click and a bare
 * click isolates.
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

function handleLabelKeydown(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    // -> Space would otherwise scroll the page
    event.preventDefault()
    handleLabelClick(event)
  }
}
</script>
