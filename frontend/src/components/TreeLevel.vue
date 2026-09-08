<template>
  <ul class="treeview-level">
    <!-- ROOT NODE -->
    <li class="treeview-node" v-if="!props.parentId">
      <!--
        The root row is the tree's own ink with a chrome glyph beside it, which is what both
        aesthetics' File Manager mockups draw (`#1c2233`/`#64789f` in Ledger, `#10194a`/`#1f4fd6` in
        Cobalt). It used to be set in the Material palette's purple in both themes -- a hue that
        appears nowhere else in either language, and that no mockup ever sanctioned.
      -->
      <div class="treeview-label" @click="setRoot" :class="{ active: !selection }">
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
    <!-- NORMAL NODES -->
    <tree-node
      v-for="node of level"
      :key="node.id"
      :node="node"
      :depth="props.depth"
      :parent-id="props.parentId" />
  </ul>
</template>

<script setup>
import { computed, inject } from 'vue'

import TreeNode from './TreeNode.vue'

// PROPS

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

// INJECT

const roots = inject('roots')
const nodes = inject('nodes')
const selection = inject('selection')
const contextActionList = inject('contextActionList')

// COMPOSABLES

// COMPUTED

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

// METHODS

function setRoot() {
  selection.value = null
}
</script>

<style lang="scss">
/*
  The root row's own two tones. Tokens rather than a `color` prop, for the reason `NavSidebar.vue`'s
  icon rule gives: `WIcon` builds its `color` class at runtime and Tailwind cannot see it, so the
  prop would resolve to nothing. Ledger's `--color-tree-root-icon` is the chrome stroke tone each
  mockup draws it in; Cobalt's is the aesthetic's own blue.
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
