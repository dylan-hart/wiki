<template>
  <ul class="treeview-level">
    <li class="treeview-node" v-if="!props.parentId">
      <!-- -> The one row that is not a `TreeNode`, so it carries that component's keyboard
              handling itself -->
      <div
        class="treeview-label"
        tabindex="0"
        role="button"
        :data-drop-folder-id="sortable ? '' : undefined"
        @click="setRoot"
        @keydown="handleRootKeydown"
        :class="{ active: !selection }">
        <w-icon class="treeview-root-icon" name="tabler:folder-share" size="sm" />
        <div class="treeview-label-text treeview-root-text">root</div>
        <w-menu v-if="rootContextActionList.length > 0" context-menu auto-close>
          <w-card class="p-2">
            <w-list dense style="min-width: 150px">
              <w-item
                v-for="action of rootContextActionList"
                :key="action.key"
                clickable
                @click="action.handler(null)">
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
        <w-icon v-if="!selection" class="treeview-root-icon" name="tabler:chevron-right" />
      </div>
    </li>
    <li v-if="sortable" class="treeview-sortgroup">
      <w-sortable
        tag="ul"
        class="treeview-level"
        :list="level"
        item-key="id"
        :options="sortableOptions"
        @update="handleReorder"
        @end="handleEnd">
        <template #item="{ element }">
          <tree-node :node="element" :depth="props.depth" :parent-id="props.parentId" />
        </template>
      </w-sortable>
    </li>
    <template v-else>
      <tree-node
        v-for="node of level"
        :key="node.id"
        :node="node"
        :depth="props.depth"
        :parent-id="props.parentId" />
    </template>
  </ul>
</template>

<script setup>
import { computed, inject, ref } from 'vue'

import TreeNode from './TreeNode.vue'
import { dropFolderAt, holdForDrop, restoreDomPosition } from '@/helpers/dropTarget'

const props = defineProps({
  depth: {
    required: true,
    type: Number
  },
  parentId: {
    type: String,
    default: null
  }
})

const roots = inject('roots')
const nodes = inject('nodes')
const selection = inject('selection')
const contextActionList = inject('contextActionList')
const sortable = inject('sortable', ref(false))
const emitReorder = inject('emitReorder', () => {})
const emitMove = inject('emitMove', () => {})

const sortableOptions = computed(() => ({
  animation: 150,
  draggable: '.treeview-node',
  onMove: holdForDrop
}))

const rootContextActionList = computed(() => {
  if (props.parentId) {
    return []
  }
  return contextActionList.value.filter((c) => c.key === 'newFolder')
})

const level = computed(() => {
  const items = []
  if (!props.parentId) {
    for (const root of roots.value) {
      items.push({
        id: root,
        ...nodes[root]
      })
    }
  } else {
    for (const node of nodes[props.parentId].children) {
      items.push({
        id: node,
        ...nodes[node]
      })
    }
  }
  return items
})

function handleEnd(event) {
  const folderId = dropFolderAt(event)
  if (folderId === undefined) {
    return
  }
  const node = level.value[event.oldIndex]
  restoreDomPosition(event)
  if (node) {
    emitMove(node.id, folderId)
  }
}

// -> Mutates `nodes`/`roots` in place: SortableJS has already moved the DOM, so the data has to
//    follow or the next patch fights it
function handleReorder(event) {
  if (dropFolderAt(event) !== undefined) {
    return
  }
  const ids = level.value.map((node) => node.id)
  ids.splice(event.newIndex, 0, ...ids.splice(event.oldIndex, 1))
  if (props.parentId) {
    nodes[props.parentId].children = ids
  } else {
    roots.value.splice(0, roots.value.length, ...ids)
  }
  emitReorder(props.parentId, ids)
}

function setRoot() {
  selection.value = null
}

function handleRootKeydown(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    setRoot()
  }
}
</script>

<style>
/*
  Tokens rather than a `color` prop on the icon: `WIcon` builds its `color` class at runtime, which
  Tailwind cannot see, so the prop would resolve to nothing.
*/
.treeview-root-text {
  color: var(--color-ink);
}

.body--dark .treeview-root-text {
  color: var(--color-text-dark);
}

.treeview-label .treeview-root-icon {
  color: var(--color-tree-root-icon);
}
</style>
