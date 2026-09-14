<template>
  <div ref="containerRef" class="w-sortable">
    <template v-for="(item, index) in list" :key="resolveKey(item)">
      <slot name="item" :element="item" :index="index" />
    </template>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import Sortable from 'sortablejs'

/**
 * A thin wrapper around `sortablejs` for a slot-rendered, drag-reorderable list (OpenProject #3165,
 * replacing `sortablejs-vue3`).
 *
 * Deliberately narrower than the library it replaces: only the `item` slot is supported (neither
 * `NavItemEditor.vue` nor `AdminLogin.vue`, the two call sites, use `header`/`footer`), and only
 * `update`/`end` are emitted -- every other SortableJS callback (`choose`, `sort`, `add`, `move`, ...)
 * is reachable directly through `options`, since those keys are passed to the `Sortable` constructor
 * unmodified. That last point is also the one place this wrapper behaves differently on purpose:
 * `sortablejs-vue3` silently overrode a user-supplied `options.onMove` with its own (to translate it
 * into a `move` event), which meant a consumer setting `onMove` directly in `options` -- exactly what
 * `NavItemEditor.vue`'s `sortableOptions.onMove` does, to block dragging into the generated block --
 * was never actually reaching SortableJS. Here `options` is spread as-is, so `onMove` (and any other
 * callback set directly in `options`) works the way a reader of that code would expect.
 */
const props = defineProps({
  /** The list being reordered. */
  list: {
    type: Array,
    required: true
  },
  /** The field name on each item holding a unique value, or a function `(item) => key`. */
  itemKey: {
    type: [String, Function],
    required: true
  },
  /** Options passed straight through to the `Sortable` constructor. */
  options: {
    type: Object,
    default: null
  }
})

const emit = defineEmits([
  /** The list's order changed within this container -- carries the native SortableJS event. */
  'update',
  /** A drag ended, whether or not the order actually changed -- carries the native SortableJS event. */
  'end'
])

const containerRef = ref(null)
let sortable = null

function resolveKey(item) {
  return typeof props.itemKey === 'function' ? props.itemKey(item) : item[props.itemKey]
}

onMounted(() => {
  sortable = new Sortable(containerRef.value, {
    ...props.options,
    onUpdate: (event) => emit('update', event),
    onEnd: (event) => emit('end', event)
  })
})

onUnmounted(() => {
  sortable?.destroy()
  sortable = null
})

// React to option changes -- e.g. `NavItemEditor.vue`'s `sortableOptions.disabled` toggling with the
// menu's mode.
watch(
  () => props.options,
  (options) => {
    if (!options || !sortable) {
      return
    }
    for (const [key, value] of Object.entries(options)) {
      sortable.option(key, value)
    }
  }
)
</script>
