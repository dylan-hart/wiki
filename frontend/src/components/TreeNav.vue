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

// PROPS

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

// EMITS

const emit = defineEmits(['update:selected', 'lazyLoad', 'contextAction'])

// I18N

const { t } = useI18n()

// DARK MODE

const dark = useDark()

// Context Actions

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

// DATA

const state = reactive({
  loaded: {},
  opened: {}
})

// COMPUTED

const selection = computed({
  get() {
    return props.selected
  },
  set(val) {
    emit('update:selected', val)
  }
})

// METHODS

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

// PROVIDE

provide('roots', toRef(props, 'roots'))
provide('nodes', props.nodes)
provide('loaded', state.loaded)
provide('opened', state.opened)
provide('displayMode', toRef(props, 'displayMode'))
provide('selection', selection)
provide('emitLazyLoad', emitLazyLoad)

// EXPOSE

defineExpose({
  setOpened,
  isLoaded,
  setLoaded,
  resetLoaded
})

// MOUNTED

onMounted(() => {
  if (props.selected) {
    for (const ancestorId of ancestorFolderIds(props.nodes, props.selected)) {
      state.opened[ancestorId] = true
    }
    state.opened[props.selected] = true
  }
})
</script>

<style lang="scss">
.treeview {
  // -> No indentation of its own any more (OpenProject #3064): a nested level used to shift its
  //    whole `<li>` right via this padding PLUS `&-node`'s own always-on `border-left` guide line
  //    below -- two lines' worth of visual nesting cue that read as a column of LINES down the
  //    tree, next to the main navbar's own hover-only DOTS (`NavSidebar.vue`'s `.w-item::before`).
  //    Indentation now lives entirely on `&-label`'s own `padding-inline-start`, driven by
  //    `--tree-depth` (`TreeNode.vue#indentStyle`) exactly the way the navbar's `--nav-depth`
  //    drives its row padding -- so a nested `<ul>` contributes no offset of its own to undo, and
  //    this only needs to cancel the `<ul>` element's OWN default list-indent, not add a per-level
  //    one. Logical, matching the navbar's own `padding-inline-start` (`NavSidebar.vue`) -- the
  //    physical `padding-left`/`margin-left` pair this replaces was the one thing keeping this file
  //    on `logicalSpacing.test.js`'s ALLOWLIST; see that file's own diff for why the entry is gone.
  &-level {
    list-style: none;
    padding-inline-start: 0;
  }

  &-node {
    display: block;
  }

  &-label {
    // -> 12px matches a toolbar's own side padding, which is what lines a row's folder icon up with
    //    the icon in the header above it. `--tree-depth` (set on this row's own `<li>` ancestor by
    //    `TreeNode.vue#indentStyle`, the same mechanism `NavSidebarItem.vue#depthStyle` sets
    //    `--nav-depth` with) adds this row's own per-level indent on top -- real padding on the
    //    row's OWN box, so its `active`/hover background still spans the tree's full width at every
    //    depth, with no ancestor box narrowing to correct for (OpenProject #853's original fix,
    //    superseded here the same way #2951 superseded it for the navbar).
    //
    // -> The main navbar's own font role (`NavSidebar.vue`'s `.sidebar-nav .w-list .w-item`):
    //    13.5px/400, rather than the ambient body 14px a tree row inherited with nothing of its own.
    padding: 4px 12px;
    padding-inline-start: calc(12px + var(--tree-depth, 0) * 10px);
    font-size: 13.5px;
    font-weight: 400;
    // -> Square: a row spans the full width of its container, and a radius on a full-width band reads
    //    as a pill that has been clipped rather than as a highlighted row
    cursor: pointer;
    display: flex;
    align-items: center;
    position: relative;

    &:hover,
    &:focus,
    &.active {
      @at-root .body--light & {
        background-color: rgba(0, 0, 0, 0.05);
      }
      @at-root .body--dark & {
        background-color: rgba(255, 255, 255, 0.1);
      }
    }

    > .w-icon {
      margin-inline-end: 5px;
    }

    &-text {
      flex: 1 0;
    }

    /*
      The depth cue itself (OpenProject #3064): one dot per ancestor indent lane, lit only on hover
      -- ported verbatim from `NavSidebar.vue`'s own `.w-item::before` rule (OpenProject #2906/
      #2932/#2951), rather than this tree's previous always-on `border-left` guide line. `--tree-depth`
      is this row's own depth (`TreeNode.vue#indentStyle`), so the trail's width scales with nesting
      the same way the navbar's does; the geometry (6px inset, 10px lanes narrowed by 4px, `max()`
      floored at 0) is the navbar's own settled formula, not re-derived independently.
    */
    &::before {
      content: '';
      position: absolute;
      inset-block: 0;
      inset-inline-start: 6px;
      width: max(0px, calc(var(--tree-depth, 0) * 10px - 4px));
      background-image: radial-gradient(circle, var(--color-slate-faint) 1px, transparent 1.4px);
      background-repeat: repeat-x;
      background-size: 10px 100%;
      background-position: left center;
      opacity: 0;
    }

    @media (hover: hover) {
      &:hover::before {
        opacity: 0.5;
      }
    }
  }
}
</style>
