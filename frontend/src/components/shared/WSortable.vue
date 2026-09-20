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
 * Deliberately narrower than `sortablejs-vue3`, which it replaces: only the `item` slot, and only
 * `update`/`end` emitted. Every other SortableJS callback is reachable through `options`, whose
 * keys reach the `Sortable` constructor unmodified -- including `onMove`, which `sortablejs-vue3`
 * silently overrode with a wrapper of its own, so a consumer setting it never reached SortableJS.
 */
const props = defineProps({
  list: {
    type: Array,
    required: true
  },
  itemKey: {
    type: [String, Function],
    required: true
  },
  options: {
    type: Object,
    default: null
  }
})

const emit = defineEmits([
  /** Order changed within this container. */
  'update',
  /** A drag ended, whether or not the order actually changed. */
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

// The constructor takes a snapshot of `options`, so a later change has to be pushed into the live
// instance key by key.
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
