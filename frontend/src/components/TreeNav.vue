<template>
  <div class="treeview">
    <tree-level :depth="0" :parent-id="null" />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, provide, reactive, toRef } from 'vue'

import TreeLevel from './TreeLevel.vue'
import { useDark } from '@/composables/dark'
import { ancestorFolderIds } from '@/helpers/treeNodes'

const props = defineProps({
  nodes: {
    type: Object,
    default: () => ({})
  },
  roots: {
    type: Array,
    default: () => []
  },
  selected: {
    type: String,
    default: null
  },
  useLazyLoad: {
    type: Boolean,
    default: false
  },
  contextActionList: {
    type: Array,
    default: () => ['newFolder', 'duplicate', 'rename', 'move', 'del']
  },
  displayMode: {
    type: String,
    default: 'title'
  }
})

const emit = defineEmits(['update:selected', 'lazyLoad', 'contextAction'])

const { t } = useI18n()

const dark = useDark()

const contextActions = computed(() => ({
  newFolder: {
    icon: 'tabler:plus',
    iconColor: dark.isActive ? 'blue-4' : 'blue',
    label: t('common.actions.newFolder')
  },
  duplicate: {
    icon: 'tabler:copy',
    iconColor: dark.isActive ? 'teal-4' : 'teal',
    label: t('common.actions.duplicate') + '...'
  },
  rename: {
    icon: 'tabler:arrow-forward-up',
    iconColor: dark.isActive ? 'teal-4' : 'teal',
    label: t('common.actions.rename') + '...'
  },
  move: {
    icon: 'tabler:arrow-right',
    iconColor: dark.isActive ? 'teal-4' : 'teal',
    label: t('common.actions.moveTo') + '...'
  },
  del: {
    icon: 'tabler:trash',
    iconColor: dark.isActive ? 'negative-fill' : 'negative',
    label: t('common.actions.delete'),
    labelColor: 'negative'
  }
}))
provide(
  'contextActionList',
  computed(() =>
    props.contextActionList.map((key) => ({
      key,
      ...contextActions.value[key],
      handler: (nodeId) => {
        emit('contextAction', nodeId, key)
      }
    }))
  )
)

const state = reactive({
  loaded: {},
  opened: {}
})

const selection = computed({
  get() {
    return props.selected
  },
  set(val) {
    emit('update:selected', val)
  }
})

function emitLazyLoad(nodeId, isCurrent, clb) {
  if (props.useLazyLoad) {
    emit('lazyLoad', nodeId, isCurrent, clb)
  } else {
    clb.done()
  }
}

function setOpened(nodeId) {
  state.opened[nodeId] = true
}
function isLoaded(nodeId) {
  return state.loaded[nodeId]
}
function setLoaded(nodeId, value) {
  state.loaded[nodeId] = value
}
function resetLoaded() {
  state.loaded = {}
}

provide('roots', toRef(props, 'roots'))
provide('nodes', props.nodes)
provide('loaded', state.loaded)
provide('opened', state.opened)
provide('displayMode', toRef(props, 'displayMode'))
provide('selection', selection)
provide('emitLazyLoad', emitLazyLoad)

defineExpose({
  setOpened,
  isLoaded,
  setLoaded,
  resetLoaded
})

onMounted(() => {
  if (props.selected) {
    for (const ancestorId of ancestorFolderIds(props.nodes, props.selected)) {
      state.opened[ancestorId] = true
    }
    state.opened[props.selected] = true
  }
})
</script>

<style>
.treeview {
  /* -> Deliberately empty: per-level indent lives entirely on `.treeview-label`'s own */
  /*    `padding-inline-start`, so a nested level adds no offset of its own here. */
}
.treeview-level {
  list-style: none;
  padding-inline-start: 0;
}
.treeview-node {
  display: block;
}
.treeview-label {
  /* -> 12px matches a toolbar's side padding, lining a row's folder icon up with the header icon */
  /*    above it. The per-level indent rides on this row's OWN box (`--tree-depth`, set by */
  /*    `TreeNode.vue#indentStyle`), so hover/active still spans the full width at every depth. */
  /* -> 13.5px/400 is the main navbar's row font role, not the ambient body 14px. */
  padding: 4px 12px;
  padding-inline-start: calc(12px + var(--tree-depth, 0) * 10px);
  font-size: 13.5px;
  font-weight: 400;
  /* -> No radius: a row spans the full container width, where one reads as a clipped pill rather */
  /*    than a highlighted row. */
  cursor: pointer;
  display: flex;
  align-items: center;
  position: relative;
}
.body--light .treeview-label:hover,
.body--light .treeview-label:focus,
.body--light .treeview-label.active {
  background-color: rgba(0, 0, 0, 0.05);
}
.body--dark .treeview-label:hover,
.body--dark .treeview-label:focus,
.body--dark .treeview-label.active {
  background-color: rgba(255, 255, 255, 0.1);
}
.treeview-label > .w-icon {
  margin-inline-end: 5px;
}
.treeview-label-text {
  flex: 1 0;
}
.treeview-label {
  /*
    Empty on purpose: the depth cue is the `::before` below -- one dot per ancestor indent lane,
    lit only on hover. Its geometry (6px inset, 10px lanes narrowed by 4px, `max()`-floored) is
    `NavSidebar.vue`'s `.w-item::before` formula, kept identical so both trees read the same.
  */
}
.treeview-label::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 6px;
  width: max(0px, var(--tree-depth, 0) * 10px - 4px);
  background-image: radial-gradient(circle, var(--color-slate-faint) 1px, transparent 1.4px);
  background-repeat: repeat-x;
  background-size: 10px 100%;
  background-position: left center;
  opacity: 0;
}
@media (hover: hover) {
  .treeview-label:hover::before {
    opacity: 0.5;
  }
}
</style>
