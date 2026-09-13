<template>
  <li class="treeview-node" :style="indentStyle">
    <!-- NODE -->
    <div class="treeview-label" @click="openNode" :class="{ active: isActive }">
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

async function toggleNode(isCurrent = false) {
  opened[props.node.id] = !(opened[props.node.id] === true)
  if (opened[props.node.id] && !loaded[props.node.id]) {
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
}

function openNode() {
  selection.value = props.node.id
  if (selection.value !== props.node.id && opened[props.node.id]) {
    return
  }
  toggleNode(true)
}
</script>
